import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { subscriptions, tasks, threads, agents } from "@getrelai/db";
import type { Db } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { assertAgentAccess, scopedAgentIds } from "../lib/ownership.js";

const createSchema = z.object({
  agentId:    z.string(),
  targetType: z.enum(["thread", "task", "agent"]),
  targetId:   z.string(),
});

// Which repo a subscription target belongs to, or null when the target does not
// exist. Delivery matches on targetType+targetId alone with no repo check, so a
// row that crosses repos is a standing leak: every event on that target reaches
// the subscriber, and the SSE payload carries the whole task row.
async function targetRepoId(
  db: Db,
  targetType: "thread" | "task" | "agent",
  targetId: string,
): Promise<string | null> {
  if (targetType === "task") {
    const [row] = await db.select({ repoId: tasks.repoId }).from(tasks).where(eq(tasks.id, targetId));
    return row?.repoId ?? null;
  }
  if (targetType === "thread") {
    const [row] = await db.select({ repoId: threads.repoId }).from(threads).where(eq(threads.id, targetId));
    return row?.repoId ?? null;
  }
  const [row] = await db.select({ repoId: agents.repoId }).from(agents).where(eq(agents.id, targetId));
  return row?.repoId ?? null;
}

export const subscriptionRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post("/subscriptions", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const access = await assertAgentAccess(request, db, body.data.agentId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: "not_found", message: "Agent not found" } });

    // Enforced for every caller, not just per-agent tokens, so the invariant is
    // simply "no subscription created through this route crosses repos".
    // ensureSubscription() is the deliberate exception: it is called server-side
    // with ids the server chose (see the feedback route).
    const repoOfTarget = await targetRepoId(db, body.data.targetType, body.data.targetId);
    if (!repoOfTarget) {
      return reply.status(404).send({ error: { code: "not_found", message: "Subscription target not found" } });
    }
    if (repoOfTarget !== access.agent.repoId) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Cannot subscribe an agent to a target in another repo" },
      });
    }

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
    const [existing] = await db.select().from(subscriptions).where(eq(subscriptions.id, request.params.id));
    if (!existing) return reply.status(404).send({ error: { code: "not_found", message: "Subscription not found" } });
    const access = await assertAgentAccess(request, db, existing.agentId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: "not_found", message: "Subscription not found" } });

    await db.delete(subscriptions).where(eq(subscriptions.id, request.params.id));
    return reply.status(204).send();
  });

  fastify.get<{ Querystring: { agentId?: string } }>("/subscriptions", async (request) => {
    const { agentId } = request.query;
    const visible = await scopedAgentIds(request, db);

    if (visible !== null) {
      if (visible.length === 0) return { data: [] };
      const where = agentId
        ? and(inArray(subscriptions.agentId, visible), eq(subscriptions.agentId, agentId))!
        : inArray(subscriptions.agentId, visible);
      const rows = await db.select().from(subscriptions).where(where);
      return { data: rows };
    }

    // Legacy API_SECRET — full visibility.
    const rows = agentId
      ? await db.select().from(subscriptions).where(eq(subscriptions.agentId, agentId))
      : await db.select().from(subscriptions);
    return { data: rows };
  });
};
