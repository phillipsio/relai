import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { agents, tokens, projects } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { assertProjectAccess } from "../lib/ownership.js";
import type { Db } from "@getrelai/db";

// Verify the caller may operate on this agent: the agent must belong to a
// project the caller can access. Returns 404 to avoid leaking existence.
async function assertAgentAccess(request: import("fastify").FastifyRequest, db: Db, agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return { ok: false as const, status: 404 as const, agent: null };
  const access = await assertProjectAccess(request, db, agent.projectId);
  if (!access.ok) return { ok: false as const, status: 404 as const, agent: null };
  return { ok: true as const, agent };
}

const registerSchema = z.object({
  projectId:      z.string(),
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

    const access = await assertProjectAccess(request, db, body.data.projectId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Project not found" } });

    const [agent] = await db.insert(agents).values({
      id:             newId("agent"),
      projectId:      body.data.projectId,
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

  fastify.get<{ Querystring: { projectId?: string } }>("/agents", async (request, reply) => {
    const { projectId } = request.query;

    // Per-agent caller: only their own project's agents.
    if (request.agent) {
      const rows = await db.select().from(agents).where(eq(agents.projectId, request.agent.projectId));
      return { data: rows };
    }

    // Service-admin: filter to projects owned by this tenant.
    if (request.ownerId) {
      const ownedProjectIds = (await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.ownerId, request.ownerId))).map((p) => p.id);
      if (ownedProjectIds.length === 0) return { data: [] };
      const where = projectId
        ? and(inArray(agents.projectId, ownedProjectIds), eq(agents.projectId, projectId))!
        : inArray(agents.projectId, ownedProjectIds);
      const rows = await db.select().from(agents).where(where);
      return { data: rows };
    }

    // Legacy API_SECRET: full visibility.
    const rows = projectId
      ? await db.select().from(agents).where(eq(agents.projectId, projectId))
      : await db.select().from(agents);
    return { data: rows };
  });
};
