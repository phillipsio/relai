import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, sql, and, inArray } from "drizzle-orm";
import { threads, messages, tasks, projects } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { publish } from "../lib/events.js";
import { assertProjectAccess } from "../lib/ownership.js";
import type { Db } from "@getrelai/db";

async function loadThreadScoped(request: import("fastify").FastifyRequest, db: Db, threadId: string) {
  const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
  if (!thread) return { ok: false as const, status: 404 as const };
  const access = await assertProjectAccess(request, db, thread.projectId);
  if (!access.ok) return { ok: false as const, status: 404 as const };
  return { ok: true as const, thread };
}

const createSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1),
  type: z.enum(["plan"]).optional(),
});

const concludeSchema = z.object({
  summary: z.string().optional(),
});

export const threadRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post("/threads", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const access = await assertProjectAccess(request, db, body.data.projectId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Project not found" } });

    const [thread] = await db.insert(threads).values({
      id: newId("thread"),
      projectId: body.data.projectId,
      title: body.data.title,
      type: body.data.type ?? null,
    }).returning();

    await publish(db, {
      id:         newId("evt"),
      kind:       "thread.created",
      projectId:  thread.projectId,
      targetType: "thread",
      targetId:   thread.id,
      payload:    { thread },
      createdAt:  thread.createdAt.toISOString(),
    });

    return reply.status(201).send({ data: thread });
  });

  fastify.get<{ Querystring: { projectId?: string; type?: string } }>("/threads", async (request, reply) => {
    const { projectId, type } = request.query;

    const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof inArray>> = [];
    if (projectId) conditions.push(eq(threads.projectId, projectId));
    if (type)      conditions.push(eq(threads.type, type));

    if (request.agent) {
      conditions.push(eq(threads.projectId, request.agent.projectId));
    } else if (request.ownerId) {
      const ownedProjectIds = (await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.ownerId, request.ownerId))).map((p) => p.id);
      if (ownedProjectIds.length === 0) return { data: [] };
      conditions.push(inArray(threads.projectId, ownedProjectIds));
    }

    const where = conditions.length === 0
      ? undefined
      : conditions.length === 1
      ? conditions[0]!
      : and(...(conditions as Parameters<typeof and>));

    const rows = await db
      .select({
        id: threads.id,
        title: threads.title,
        projectId: threads.projectId,
        type: threads.type,
        status: threads.status,
        summary: threads.summary,
        createdAt: threads.createdAt,
        messageCount: sql<number>`cast(count(${messages.id}) as int)`,
      })
      .from(threads)
      .leftJoin(messages, eq(messages.threadId, threads.id))
      .where(where)
      .groupBy(threads.id);

    return { data: rows };
  });

  fastify.delete<{ Params: { id: string } }>("/threads/:id", async (request, reply) => {
    const { id } = request.params;
    const scope = await loadThreadScoped(request, db, id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Thread not found" } });

    await db.delete(messages).where(eq(messages.threadId, id));
    await db.delete(threads).where(eq(threads.id, id));

    return reply.status(204).send();
  });

  fastify.put<{ Params: { id: string } }>("/threads/:id/conclude", async (request, reply) => {
    const body = concludeSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const scope = await loadThreadScoped(request, db, request.params.id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Thread not found" } });

    const [thread] = await db
      .update(threads)
      .set({ status: "concluded", summary: body.data.summary ?? null })
      .where(eq(threads.id, request.params.id))
      .returning();

    await publish(db, {
      id:         newId("evt"),
      kind:       "thread.concluded",
      projectId:  thread.projectId,
      targetType: "thread",
      targetId:   thread.id,
      payload:    { thread },
      createdAt:  new Date().toISOString(),
    });

    return { data: thread };
  });
};
