import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { agents, tokens, repos } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { assertRepoAccess, assertAgentAccess } from "../lib/ownership.js";
import type { Db } from "@getrelai/db";

const registerSchema = z.object({
  repoId:      z.string(),
  name:           z.string().min(1),
  role:           z.enum(["orchestrator", "worker"]),
  specialization: z.string().optional(),
  tier:           z.number().int().min(1).max(2).optional(),
  domains:        z.array(z.string()).default([]),
  workerType:     z.enum(["claude", "copilot", "cursor", "windsurf", "gemini", "gpt", "mcp", "human"]).optional(),
  repoPath:       z.string().optional(),
});

export const agentRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post("/agents", async (request, reply) => {
    const body = registerSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const access = await assertRepoAccess(request, db, body.data.repoId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });

    const [agent] = await db.insert(agents).values({
      id:             newId("agent"),
      repoId:      body.data.repoId,
      name:           body.data.name,
      role:           body.data.role,
      specialization: body.data.specialization ?? null,
      tier:           body.data.tier ?? null,
      domains:        body.data.domains,
      workerType:     body.data.workerType ?? null,
      repoPath:       body.data.repoPath ?? null,
      lastSeenAt:     new Date(0), // never connected; first heartbeat marks it online
    }).returning();

    const plaintext = generateToken();
    await db.insert(tokens).values({
      id:        newId("tok"),
      agentId:   agent.id,
      tokenHash: hashToken(plaintext),
    });

    return reply.status(201).send({ data: agent, token: plaintext });
  });

  fastify.post<{ Params: { id: string } }>("/agents/:id/tokens", async (request, reply) => {
    const check = await assertAgentAccess(request, db, request.params.id);
    if (!check.ok) return reply.status(check.status).send({ error: { code: "not_found", message: "Agent not found" } });
    const agent = check.agent;

    const plaintext = generateToken();
    const [row] = await db.insert(tokens).values({
      id:        newId("tok"),
      agentId:   agent.id,
      tokenHash: hashToken(plaintext),
    }).returning();

    return reply.status(201).send({ data: row, token: plaintext });
  });

  fastify.put<{ Params: { id: string } }>("/agents/:id/heartbeat", async (request, reply) => {
    const check = await assertAgentAccess(request, db, request.params.id);
    if (!check.ok) return reply.status(check.status).send({ error: { code: "not_found", message: "Agent not found" } });

    const [agent] = await db
      .update(agents)
      .set({ lastSeenAt: new Date() })
      .where(eq(agents.id, request.params.id))
      .returning();

    return { data: agent };
  });

  fastify.get<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    const check = await assertAgentAccess(request, db, request.params.id);
    if (!check.ok) return reply.status(check.status).send({ error: { code: "not_found", message: "Agent not found" } });
    return { data: check.agent };
  });

  fastify.delete<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    const check = await assertAgentAccess(request, db, request.params.id);
    if (!check.ok) return reply.status(check.status).send({ error: { code: "not_found", message: "Agent not found" } });
    await db.delete(agents).where(eq(agents.id, request.params.id));
    return reply.status(204).send();
  });

  fastify.get<{ Querystring: { repoId?: string } }>("/agents", async (request, reply) => {
    const { repoId } = request.query;

    // Per-agent caller: only their own project's agents.
    if (request.agent) {
      const rows = await db.select().from(agents).where(eq(agents.repoId, request.agent.repoId));
      return { data: rows };
    }

    // Service-admin: filter to repos owned by this tenant.
    if (request.ownerId) {
      const ownedRepoIds = (await db
        .select({ id: repos.id })
        .from(repos)
        .where(eq(repos.ownerId, request.ownerId))).map((p) => p.id);
      if (ownedRepoIds.length === 0) return { data: [] };
      const where = repoId
        ? and(inArray(agents.repoId, ownedRepoIds), eq(agents.repoId, repoId))!
        : inArray(agents.repoId, ownedRepoIds);
      const rows = await db.select().from(agents).where(where);
      return { data: rows };
    }

    // Legacy API_SECRET: full visibility.
    const rows = repoId
      ? await db.select().from(agents).where(eq(agents.repoId, repoId))
      : await db.select().from(agents);
    return { data: rows };
  });
};
