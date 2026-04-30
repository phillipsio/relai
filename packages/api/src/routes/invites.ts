import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { agents, invites, projects, tokens } from "@relai/db";
import type { Db } from "@relai/db";
import { newId } from "../lib/id.js";
import { generateInviteCode, generateToken, hashSecret } from "../lib/tokens.js";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const createSchema = z.object({
  suggestedName: z.string().min(1).optional(),
  suggestedSpecialization: z.string().min(1).optional(),
  ttlSeconds: z.number().int().positive().optional(),
});

const acceptSchema = z.object({
  code:           z.string().min(1),
  name:           z.string().min(1),
  role:           z.enum(["orchestrator", "worker"]).default("worker"),
  specialization: z.string().min(1).optional(),
  workerType:     z.enum(["claude", "copilot", "cursor", "windsurf", "gemini", "gpt", "mcp", "human"]).optional(),
  domains:        z.array(z.string()).default([]),
});

export const inviteRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post<{ Params: { id: string } }>("/projects/:id/invites", async (request, reply) => {
    const [project] = await db.select().from(projects).where(eq(projects.id, request.params.id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Project not found" } });

    const body = createSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const code = generateInviteCode();
    const ttl  = body.data.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const [row] = await db.insert(invites).values({
      id:        newId("invite"),
      projectId: project.id,
      codeHash:  hashSecret(code),
      createdBy: request.agent?.id ?? null,
      suggestedName:           body.data.suggestedName           ?? null,
      suggestedSpecialization: body.data.suggestedSpecialization ?? null,
      expiresAt: new Date(Date.now() + ttl * 1000),
    }).returning();

    return reply.status(201).send({ data: row, code });
  });

  fastify.get<{ Params: { id: string } }>("/projects/:id/invites", async (request, reply) => {
    const [project] = await db.select().from(projects).where(eq(projects.id, request.params.id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Project not found" } });

    const rows = await db.select().from(invites).where(eq(invites.projectId, project.id));
    return { data: rows };
  });

  fastify.delete<{ Params: { id: string } }>("/invites/:id", async (request, reply) => {
    const [row] = await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(eq(invites.id, request.params.id))
      .returning();
    if (!row) return reply.status(404).send({ error: { code: "not_found", message: "Invite not found" } });
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

    const [agent] = await db.insert(agents).values({
      id:             newId("agent"),
      projectId:      invite.projectId,
      name:           body.data.name,
      role:           body.data.role,
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
