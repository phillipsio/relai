import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, sql, asc } from "drizzle-orm";
import { messages, threads, tasks } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { publish, ensureSubscription } from "../lib/events.js";
import { assertProjectAccess } from "../lib/ownership.js";
import type { Db } from "@getrelai/db";

async function assertThreadAccess(request: import("fastify").FastifyRequest, db: Db, threadId: string) {
  const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
  if (!thread) return { ok: false as const, status: 404 as const };
  const access = await assertProjectAccess(request, db, thread.projectId);
  if (!access.ok) return { ok: false as const, status: 404 as const };
  return { ok: true as const, thread };
}

const createSchema = z.object({
  fromAgent: z.string(),
  toAgent:   z.string().optional(),
  type:      z.enum(["status", "handoff", "finding", "decision", "question", "escalation", "reply"]),
  body:      z.string().min(1),
  metadata:  z.record(z.unknown()).default({}),
});

export const messageRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post<{ Params: { id: string } }>("/threads/:id/messages", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const scope = await assertThreadAccess(request, db, request.params.id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Thread not found" } });

    const [message] = await db.insert(messages).values({
      id:        newId("msg"),
      threadId:  request.params.id,
      fromAgent: body.data.fromAgent,
      toAgent:   body.data.toAgent,
      type:      body.data.type,
      body:      body.data.body,
      metadata:  body.data.metadata,
    }).returning();

    // Escalations: auto-create a high-priority pending task — the scheduler
    // will route it. When ENABLE_MESSAGE_ROUTING is on, the in-API message
    // loop owns the escalation lifecycle (creates a task assigned directly
    // to a senior agent, posts a reply on the thread); skipping here avoids
    // a duplicate task per escalation message.
    const messageLoopOwnsEscalation =
      process.env.ENABLE_MESSAGE_ROUTING === "true" || process.env.ENABLE_MESSAGE_ROUTING === "1";
    if (body.data.type === "escalation" && !messageLoopOwnsEscalation) {
      const [thread] = await db.select().from(threads).where(eq(threads.id, request.params.id));
      if (thread) {
        await db.insert(tasks).values({
          id:             newId("task"),
          projectId:      thread.projectId,
          title:          body.data.body.trimStart().slice(0, 80).trimEnd(),
          description:    body.data.body,
          priority:       "urgent",
          domains:        [],
          specialization: "architect",
          createdBy:      body.data.fromAgent,
          metadata: {
            escalationThreadId:  request.params.id,
            escalationMessageId: message.id,
            escalatedFrom:       body.data.fromAgent,
          },
        });
      }
    }

    // Auto-subscribe sender + recipient (if any) to the thread.
    await ensureSubscription(db, body.data.fromAgent, "thread", request.params.id);
    if (body.data.toAgent) {
      await ensureSubscription(db, body.data.toAgent, "thread", request.params.id);
    }

    const [thread] = await db.select().from(threads).where(eq(threads.id, request.params.id));
    await publish(db, {
      id:         newId("evt"),
      kind:       "message.posted",
      projectId:  thread?.projectId ?? "",
      targetType: "thread",
      targetId:   request.params.id,
      alsoNotify: body.data.toAgent
        ? [{ targetType: "agent", targetId: body.data.toAgent }]
        : [],
      payload:    { message },
      createdAt:  message.createdAt.toISOString(),
    });

    return reply.status(201).send({ data: message });
  });

  fastify.get<{ Params: { id: string } }>("/threads/:id/messages", async (request, reply) => {
    const scope = await assertThreadAccess(request, db, request.params.id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Thread not found" } });
    const rows = await db.select().from(messages).where(eq(messages.threadId, request.params.id)).orderBy(asc(messages.createdAt));
    return { data: rows };
  });

  fastify.put<{ Params: { id: string }; Body: { agentId: string } }>(
    "/threads/:id/messages/read",
    async (request, reply) => {
      const { agentId } = request.body as { agentId: string };
      if (!agentId) return reply.status(400).send({ error: { code: "validation_error", message: "agentId required" } });

      const scope = await assertThreadAccess(request, db, request.params.id);
      if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Thread not found" } });

      await db
        .update(messages)
        .set({ readBy: sql`array_append(read_by, ${agentId})` })
        .where(eq(messages.threadId, request.params.id));

      return { ok: true };
    }
  );

  fastify.get<{ Querystring: { agentId: string; projectId: string } }>("/messages/unread", async (request, reply) => {
    const { agentId, projectId } = request.query;
    if (!agentId)   return reply.status(400).send({ error: { code: "validation_error", message: "agentId required" } });
    if (!projectId) return reply.status(400).send({ error: { code: "validation_error", message: "projectId required" } });

    const access = await assertProjectAccess(request, db, projectId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Project not found" } });

    const rows = await db
      .select({ messages })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(
        sql`${threads.projectId} = ${projectId} AND NOT (${messages.readBy} @> ARRAY[${agentId}]::text[])`,
      );

    return { data: rows.map((r) => r.messages) };
  });
};
