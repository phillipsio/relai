import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { subscriptions } from "@relai/db";
import type { Db } from "@relai/db";
import { newId } from "../lib/id.js";

const createSchema = z.object({
  agentId:    z.string(),
  targetType: z.enum(["thread", "task", "agent"]),
  targetId:   z.string(),
});

export const subscriptionRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post("/subscriptions", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    // Idempotent: if the subscription already exists, return it instead of duplicating.
    const [existing] = await db.select().from(subscriptions).where(and(
      eq(subscriptions.agentId,    body.data.agentId),
      eq(subscriptions.targetType, body.data.targetType),
      eq(subscriptions.targetId,   body.data.targetId),
    ));
    if (existing) return reply.status(200).send({ data: existing });

    const [row] = await db.insert(subscriptions).values({
      id: newId("sub"),
      ...body.data,
    }).returning();
    return reply.status(201).send({ data: row });
  });

  fastify.delete<{ Params: { id: string } }>("/subscriptions/:id", async (request, reply) => {
    const [row] = await db.delete(subscriptions).where(eq(subscriptions.id, request.params.id)).returning();
    if (!row) return reply.status(404).send({ error: { code: "not_found", message: "Subscription not found" } });
    return reply.status(204).send();
  });

  fastify.get<{ Querystring: { agentId?: string } }>("/subscriptions", async (request) => {
    const { agentId } = request.query;
    const rows = agentId
      ? await db.select().from(subscriptions).where(eq(subscriptions.agentId, agentId))
      : await db.select().from(subscriptions);
    return { data: rows };
  });
};
