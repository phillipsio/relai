import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { agents, tokens } from "@relai/db";
import { newId } from "../lib/id.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import type { Db } from "@relai/db";

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
    const [agent] = await db.select().from(agents).where(eq(agents.id, request.params.id));
    if (!agent) return reply.status(404).send({ error: { code: "not_found", message: "Agent not found" } });

    const plaintext = generateToken();
    const [row] = await db.insert(tokens).values({
      id:        newId("tok"),
      agentId:   agent.id,
      tokenHash: hashToken(plaintext),
    }).returning();

    return reply.status(201).send({ data: row, token: plaintext });
  });

  fastify.put<{ Params: { id: string } }>("/agents/:id/heartbeat", async (request, reply) => {
    const [agent] = await db
      .update(agents)
      .set({ lastSeenAt: new Date() })
      .where(eq(agents.id, request.params.id))
      .returning();

    if (!agent) return reply.status(404).send({ error: { code: "not_found", message: "Agent not found" } });
    return { data: agent };
  });

  fastify.get<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    const [agent] = await db.select().from(agents).where(eq(agents.id, request.params.id));
    if (!agent) return reply.status(404).send({ error: { code: "not_found", message: "Agent not found" } });
    return { data: agent };
  });

  fastify.delete<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    const [agent] = await db.delete(agents).where(eq(agents.id, request.params.id)).returning();
    if (!agent) return reply.status(404).send({ error: { code: "not_found", message: "Agent not found" } });
    return reply.status(204).send();
  });

  fastify.get<{ Querystring: { projectId?: string } }>("/agents", async (request, reply) => {
    const { projectId } = request.query;
    const rows = projectId
      ? await db.select().from(agents).where(eq(agents.projectId, projectId))
      : await db.select().from(agents);
    return { data: rows };
  });
};
