import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, sql, and } from "drizzle-orm";
import { threads, messages, tasks } from "@relai/db";
import { newId } from "../lib/id.js";
import type { Db } from "@relai/db";

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

    const [thread] = await db.insert(threads).values({
      id: newId("thread"),
      projectId: body.data.projectId,
      title: body.data.title,
      type: body.data.type ?? null,
    }).returning();

    return reply.status(201).send({ data: thread });
  });

  fastify.get<{ Querystring: { projectId?: string; type?: string } }>("/threads", async (request, reply) => {
    const { projectId, type } = request.query;

    const conditions = [
      projectId ? eq(threads.projectId, projectId) : null,
      type ? eq(threads.type, type) : null,
    ].filter(Boolean);

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
    const [thread] = await db.select().from(threads).where(eq(threads.id, id));
    if (!thread) return reply.status(404).send({ error: { code: "not_found", message: "Thread not found" } });

    await db.delete(messages).where(eq(messages.threadId, id));
    await db.delete(threads).where(eq(threads.id, id));

    return reply.status(204).send();
  });

  fastify.put<{ Params: { id: string } }>("/threads/:id/conclude", async (request, reply) => {
    const body = concludeSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const [thread] = await db
      .update(threads)
      .set({ status: "concluded", summary: body.data.summary ?? null })
      .where(eq(threads.id, request.params.id))
      .returning();

    if (!thread) return reply.status(404).send({ error: { code: "not_found", message: "Thread not found" } });
    return { data: thread };
  });
};
