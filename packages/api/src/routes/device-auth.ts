import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, eq, isNull, lt } from "drizzle-orm";
import { deviceAuthorizations, invites, repos } from "@getrelai/db";
import type { Db } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { generateDeviceCode, generateInviteCode, generateUserCode, hashSecret } from "../lib/tokens.js";
import { assertRepoAccess } from "../lib/ownership.js";

const TTL_SECONDS = 10 * 60;
const POLL_INTERVAL_SECONDS = 5;

// The API registers no rate-limit plugin, and this is the only route reachable
// with no credential at all. Per-process is enough on a single-box deploy.
const recentStarts = new Map<string, number[]>();

// Read per call, not cached, so a test can tighten or loosen it after import.
const startsPerMinute = () => {
  const raw = process.env.DEVICE_START_RATE_LIMIT ?? "";
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : 10;
};

function tooManyStarts(ip: string, now: number): boolean {
  const window = (recentStarts.get(ip) ?? []).filter((t) => now - t < 60_000);
  window.push(now);
  recentStarts.set(ip, window);
  if (recentStarts.size > 5_000) {
    for (const [k, v] of recentStarts) if (v.every((t) => now - t >= 60_000)) recentStarts.delete(k);
  }
  return window.length > startsPerMinute();
}

const WORKER_TYPES = ["claude", "copilot", "cursor", "windsurf", "gemini", "gpt", "mcp", "human"] as const;

const startSchema = z.object({
  proposed: z.object({
    repoName: z.string().max(200).optional(),
    remote:   z.string().max(400).optional(),
    host:     z.enum(WORKER_TYPES).optional(),
  }).strict().default({}),
});

const grantSchema = z.object({
  name:           z.string().min(1).max(80),
  workerType:     z.enum(WORKER_TYPES),
  role:           z.enum(["orchestrator", "worker"]).default("worker"),
  specialization: z.string().min(1).optional(),
  domains:        z.array(z.string()).default([]),
});

const approveSchema = z.object({
  userCode: z.string().min(1),
  repoId:   z.string().min(1),
  // An empty approval would otherwise read as success and hand back nothing.
  agents:   z.array(grantSchema).min(1),
});

const denySchema = z.object({ userCode: z.string().min(1) });

type Grant = z.infer<typeof grantSchema>;

export const deviceAuthRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  const publicBase = () =>
    process.env.RELAI_DASHBOARD_URL?.replace(/\/+$/, "") ?? "http://localhost:4000";

  // Public: no credential exists yet. Whitelisted in the auth plugin.
  fastify.post("/auth/device/start", async (request, reply) => {
    const body = startSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const now = Date.now();
    if (tooManyStarts(request.ip, now)) {
      return reply.status(429).send({ error: { code: "slow_down", message: "Too many device requests from this address" } });
    }
    // Nothing else deletes these, and an abandoned row is worthless the moment
    // it expires.
    await db.delete(deviceAuthorizations).where(lt(deviceAuthorizations.expiresAt, new Date(now - 60 * 60 * 1000)));

    const deviceCode = generateDeviceCode();
    const [row] = await db.insert(deviceAuthorizations).values({
      id:             newId("devauth"),
      userCode:       generateUserCode(),
      deviceCodeHash: hashSecret(deviceCode),
      proposed:       body.data.proposed,
      expiresAt:      new Date(Date.now() + TTL_SECONDS * 1000),
    }).returning();

    return reply.status(201).send({
      data: {
        userCode:        row.userCode,
        verificationUri: `${publicBase()}/device`,
        expiresIn:       TTL_SECONDS,
        interval:        POLL_INTERVAL_SECONDS,
      },
      deviceCode,
    });
  });

  // Public — the device code in the Authorization header is the credential.
  fastify.post("/auth/device/token", async (request, reply) => {
    const auth = request.headers.authorization;
    const deviceCode = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    const invalid = { error: { code: "invalid_device_code", message: "Unknown device code" } };
    if (!deviceCode) return reply.status(400).send(invalid);

    const [row] = await db.select().from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeHash, hashSecret(deviceCode)));
    if (!row) return reply.status(400).send(invalid);

    // Rate limit before anything else, so a hot loop cannot probe state either.
    const now = Date.now();
    if (row.lastPolledAt && now - row.lastPolledAt.getTime() < POLL_INTERVAL_SECONDS * 1000) {
      return reply.status(429).send({
        error: { code: "slow_down", message: `Poll at most every ${POLL_INTERVAL_SECONDS}s` },
      });
    }
    await db.update(deviceAuthorizations)
      .set({ lastPolledAt: new Date(now) })
      .where(eq(deviceAuthorizations.id, row.id));

    if (row.expiresAt.getTime() < now) {
      return reply.status(400).send({ error: { code: "expired_token", message: "This device code is no longer usable" } });
    }
    if (row.status === "denied") {
      return reply.status(403).send({ error: { code: "access_denied", message: "A human declined this request" } });
    }
    if (row.status !== "approved") {
      return reply.status(428).send({ error: { code: "authorization_pending", message: "Waiting for approval" } });
    }

    const granted = (row.granted ?? []) as Grant[];
    const repoId  = row.repoId;
    if (!repoId || granted.length === 0) {
      return reply.status(500).send({ error: { code: "internal_error", message: "Approved authorization is missing its grant" } });
    }

    // Minted here, not at approval, so a code never sits at rest. The
    // conditional update is the ONLY consumption guard: do not add an early one.
    const minted = await db.transaction(async (tx) => {
      const [claimed] = await tx.update(deviceAuthorizations)
        .set({ consumedAt: new Date(now) })
        .where(and(eq(deviceAuthorizations.id, row.id), isNull(deviceAuthorizations.consumedAt)))
        .returning();
      if (!claimed) return null;

      return Promise.all(granted.map(async (g) => {
        const code = generateInviteCode();
        await tx.insert(invites).values({
          id:        newId("invite"),
          repoId,
          codeHash:  hashSecret(code),
          role:      g.role,
          suggestedName:           g.name,
          suggestedSpecialization: g.specialization ?? null,
          expiresAt: new Date(now + TTL_SECONDS * 1000),
          deviceAuthorizationId: row.id,
        });
        return { name: g.name, workerType: g.workerType, role: g.role, specialization: g.specialization ?? null, domains: g.domains, code };
      }));
    });

    if (!minted) {
      return reply.status(400).send({ error: { code: "expired_token", message: "This device code is no longer usable" } });
    }
    return reply.status(200).send({ data: { repoId }, invites: minted });
  });

  // The first tenant to look a code up claims it; nobody else may read, approve
  // or deny it. Without this, a code glimpsed on a screen-share is actionable by
  // any account on the instance.
  async function findForOwner(userCode: string, ownerId: string | undefined) {
    const [row] = await db.select().from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, userCode.trim().toUpperCase()));
    if (!row) return null;
    if (!ownerId) return row;
    return !row.claimedBy || row.claimedBy === ownerId ? row : null;
  }

  // Taken on the FIRST LOOK, not the first action. Binding late would let anyone
  // who learns a code approve it into their own repo, which is the attack: the
  // victim's CLI then writes the attacker's tokens.
  async function claim(userCode: string, ownerId: string | undefined) {
    const row = await findForOwner(userCode, ownerId);
    if (!row || !ownerId || row.claimedBy === ownerId) return row;
    const [claimed] = await db.update(deviceAuthorizations)
      .set({ claimedBy: ownerId })
      .where(and(eq(deviceAuthorizations.id, row.id), isNull(deviceAuthorizations.claimedBy)))
      .returning();
    if (claimed) return claimed;
    // Lost the race. Re-read: if the winner was us, this is still our row.
    const [after] = await db.select().from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.id, row.id));
    return after?.claimedBy === ownerId ? after : null;
  }

  // These routes are the dashboard acting for a signed-in person. An agent token
  // is not that. Neither is the legacy shared secret, which sets no owner at all
  // and so falls through every tenant check below: on a multi-tenant deploy it
  // could read and approve any tenant's code. routes/session.ts refuses it the
  // same way. A single-tenant box has no SERVICE_ADMIN_TOKEN and keeps working.
  function refuseNonDashboard(request: FastifyRequest): boolean {
    if (request.agent) return true;
    if (request.ownerId) return false;
    // Fail CLOSED. This used to infer "multi-tenant" from SERVICE_ADMIN_TOKEN
    // being set on the API, and the documented deploy only sets it on the cloud,
    // so the guard evaluated false on exactly the configuration the docs produce.
    // A self-hoster opts in explicitly instead of being guessed at.
    return process.env.DEVICE_ALLOW_LEGACY_SECRET !== "true";
  }

  // Service-admin only: what the approval screen reads to pre-fill itself.
  fastify.get<{ Params: { userCode: string } }>("/auth/device/pending/:userCode", async (request, reply) => {
    if (refuseNonDashboard(request)) return reply.status(404).send({ error: { code: "not_found", message: "Unknown code" } });
    const row = await claim(request.params.userCode, request.ownerId);
    if (!row) return reply.status(404).send({ error: { code: "not_found", message: "Unknown code" } });

    // Named fields, not the row: deviceCodeHash must never leave the server.
    return reply.status(200).send({
      data: {
        userCode:  row.userCode,
        status:    row.status,
        proposed:  row.proposed,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        expired:   row.expiresAt.getTime() < Date.now(),
      },
    });
  });

  // Service-admin only: relai-cloud calls this once a human has approved.
  fastify.post("/auth/device/approve", async (request, reply) => {
    if (refuseNonDashboard(request)) return reply.status(404).send({ error: { code: "not_found", message: "Unknown code" } });
    const body = approveSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    // Ownership, not mere existence: approving mints agents inside the repo, so
    // a signed-in tenant must not be able to name someone else's.
    const access = await assertRepoAccess(request, db, body.data.repoId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
    const [repo] = await db.select().from(repos).where(eq(repos.id, body.data.repoId));
    if (!repo) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });

    if (body.data.agents.some((a) => a.role === "orchestrator") && request.agent && request.agent.role !== "orchestrator") {
      return reply.status(403).send({ error: { code: "forbidden", message: "Only orchestrator agents may grant the orchestrator role." } });
    }

    const row = await claim(body.data.userCode, request.ownerId);
    if (!row) return reply.status(404).send({ error: { code: "not_found", message: "Unknown code" } });
    if (row.status !== "pending") {
      return reply.status(409).send({ error: { code: "already_decided", message: `This request is already ${row.status}` } });
    }
    if (row.expiresAt.getTime() < Date.now()) {
      return reply.status(400).send({ error: { code: "expired_token", message: "This request expired before it was approved" } });
    }

    const [updated] = await db.update(deviceAuthorizations)
      .set({
        status:     "approved",
        granted:    body.data.agents,
        repoId:     repo.id,
      })
      .where(and(eq(deviceAuthorizations.id, row.id), eq(deviceAuthorizations.status, "pending")))
      .returning();
    if (!updated) return reply.status(409).send({ error: { code: "already_decided", message: "This request is already decided" } });

    return reply.status(200).send({ data: { repoId: repo.id, agents: body.data.agents.length } });
  });

  fastify.post("/auth/device/deny", async (request, reply) => {
    if (refuseNonDashboard(request)) return reply.status(404).send({ error: { code: "not_found", message: "Unknown or already-decided code" } });
    const body = denySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const row = await claim(body.data.userCode, request.ownerId);
    if (!row) return reply.status(404).send({ error: { code: "not_found", message: "Unknown or already-decided code" } });

    const [updated] = await db.update(deviceAuthorizations)
      .set({ status: "denied" })
      .where(and(eq(deviceAuthorizations.id, row.id), eq(deviceAuthorizations.status, "pending")))
      .returning();
    if (!updated) return reply.status(404).send({ error: { code: "not_found", message: "Unknown or already-decided code" } });

    return reply.status(204).send();
  });
};
