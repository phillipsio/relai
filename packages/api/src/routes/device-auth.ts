import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { deviceAuthorizations, invites, repos } from "@getrelai/db";
import type { Db } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { generateDeviceCode, generateInviteCode, generateUserCode, hashSecret } from "../lib/tokens.js";

const TTL_SECONDS = 10 * 60;
const POLL_INTERVAL_SECONDS = 5;

const WORKER_TYPES = ["claude", "copilot", "cursor", "windsurf", "gemini", "gpt", "mcp", "human"] as const;

const startSchema = z.object({
  proposed: z.record(z.unknown()).default({}),
});

const grantSchema = z.object({
  name:           z.string().min(1),
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

  // Service-admin only: relai-cloud calls this once a human has approved.
  fastify.post("/auth/device/approve", async (request, reply) => {
    const body = approveSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const [repo] = await db.select().from(repos).where(eq(repos.id, body.data.repoId));
    if (!repo) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });

    const [row] = await db.select().from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, body.data.userCode.toUpperCase()));
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
        approvedBy: request.ownerId ?? null,
      })
      .where(and(eq(deviceAuthorizations.id, row.id), eq(deviceAuthorizations.status, "pending")))
      .returning();
    if (!updated) return reply.status(409).send({ error: { code: "already_decided", message: "This request is already decided" } });

    return reply.status(200).send({ data: { repoId: repo.id, agents: body.data.agents.length } });
  });

  fastify.post("/auth/device/deny", async (request, reply) => {
    const body = denySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const [updated] = await db.update(deviceAuthorizations)
      .set({ status: "denied" })
      .where(and(
        eq(deviceAuthorizations.userCode, body.data.userCode.toUpperCase()),
        eq(deviceAuthorizations.status, "pending"),
      ))
      .returning();
    if (!updated) return reply.status(404).send({ error: { code: "not_found", message: "Unknown or already-decided code" } });

    return reply.status(204).send();
  });
};
