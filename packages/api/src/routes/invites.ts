import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { agents, invites, repos, tokens } from "@getrelai/db";
import type { Db } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { generateInviteCode, generateToken, hashSecret } from "../lib/tokens.js";
import { assertRepoAccess } from "../lib/ownership.js";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const createSchema = z.object({
  suggestedName: z.string().min(1).optional(),
  suggestedSpecialization: z.string().min(1).optional(),
  ttlSeconds: z.number().int().positive().optional(),
  // Pinned onto the invite row. Defaults to worker so an unqualified invite can
  // never hand out the privileged role.
  role: z.enum(["orchestrator", "worker"]).optional(),
});

const acceptSchema = z.object({
  code:           z.string().min(1),
  name:           z.string().min(1),
  // Advisory only: the granted role comes from the invite. Kept so existing
  // clients keep working, and cross-checked below so a mismatch is refused
  // rather than silently downgraded. Must NOT default, or omitting it would
  // conflict with an orchestrator invite.
  role:           z.enum(["orchestrator", "worker"]).optional(),
  specialization: z.string().min(1).optional(),
  workerType:     z.enum(["claude", "copilot", "cursor", "windsurf", "gemini", "gpt", "mcp", "human"]).optional(),
  domains:        z.array(z.string()).default([]),
});

export const inviteRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post<{ Params: { id: string } }>("/repos/:id/invites", async (request, reply) => {
    const access = await assertRepoAccess(request, db, request.params.id);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
    const [project] = await db.select().from(repos).where(eq(repos.id, request.params.id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });

    const body = createSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    // Minting a privileged invite is itself privileged, or the accepter gate is
    // just moved one hop rather than closed.
    const role = body.data.role ?? "worker";
    if (role === "orchestrator" && request.agent && request.agent.role !== "orchestrator") {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Only orchestrator agents may issue an orchestrator invite." },
      });
    }

    const code = generateInviteCode();
    const ttl  = body.data.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const [row] = await db.insert(invites).values({
      id:        newId("invite"),
      repoId: project.id,
      codeHash:  hashSecret(code),
      createdBy: request.agent?.id ?? null,
      role,
      suggestedName:           body.data.suggestedName           ?? null,
      suggestedSpecialization: body.data.suggestedSpecialization ?? null,
      expiresAt: new Date(Date.now() + ttl * 1000),
    }).returning();

    return reply.status(201).send({ data: row, code });
  });

  fastify.get<{ Params: { id: string } }>("/repos/:id/invites", async (request, reply) => {
    const access = await assertRepoAccess(request, db, request.params.id);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
    const [project] = await db.select().from(repos).where(eq(repos.id, request.params.id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });

    const rows = await db.select().from(invites).where(eq(invites.repoId, project.id));
    return { data: rows };
  });

  fastify.delete<{ Params: { id: string } }>("/invites/:id", async (request, reply) => {
    const [existing] = await db.select().from(invites).where(eq(invites.id, request.params.id));
    if (!existing) return reply.status(404).send({ error: { code: "not_found", message: "Invite not found" } });
    const access = await assertRepoAccess(request, db, existing.repoId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Invite not found" } });

    await db.update(invites)
      .set({ revokedAt: new Date() })
      .where(eq(invites.id, request.params.id));
    return reply.status(204).send();
  });

  // Public — must be whitelisted in the auth plugin.
  fastify.post("/auth/accept-invite", async (request, reply) => {
    const body = acceptSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const [invite] = await db.select().from(invites).where(eq(invites.codeHash, hashSecret(body.data.code)));
    if (!invite)              return reply.status(400).send({ error: { code: "invalid_invite", message: "Unknown invite code" } });
    if (invite.acceptedAt)    return reply.status(400).send({ error: { code: "invalid_invite", message: "Invite already accepted" } });
    if (invite.revokedAt)     return reply.status(400).send({ error: { code: "invalid_invite", message: "Invite revoked" } });
    if (invite.expiresAt.getTime() < Date.now())
                              return reply.status(400).send({ error: { code: "invalid_invite", message: "Invite expired" } });

    // The invite grants the role. A body value that disagrees is refused rather
    // than downgraded, so an escalation attempt surfaces.
    if (body.data.role && body.data.role !== invite.role) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "This invite does not grant that role" },
      });
    }

    const [agent] = await db.insert(agents).values({
      id:             newId("agent"),
      repoId:      invite.repoId,
      name:           body.data.name,
      role:           invite.role,
      specialization: body.data.specialization ?? invite.suggestedSpecialization ?? null,
      domains:        body.data.domains,
      workerType:     body.data.workerType ?? null,
      lastSeenAt:     new Date(0),
    }).returning();

    const plaintext = generateToken();
    await db.insert(tokens).values({
      id:        newId("tok"),
      agentId:   agent.id,
      tokenHash: hashSecret(plaintext),
    });

    await db.update(invites)
      .set({ acceptedAt: new Date(), acceptedAgentId: agent.id })
      .where(eq(invites.id, invite.id));

    return reply.status(201).send({ data: agent, token: plaintext });
  });
};
