import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, sql, and, inArray, isNull } from "drizzle-orm";
import { threads, messages, tasks, repos } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { publish } from "../lib/events.js";
import { assertRepoAccess, loadThreadScoped } from "../lib/ownership.js";
import type { Db } from "@getrelai/db";


const createSchema = z.object({
  repoId: z.string(),
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

    const access = await assertRepoAccess(request, db, body.data.repoId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });

    const [thread] = await db.insert(threads).values({
      id: newId("thread"),
      repoId: body.data.repoId,
      title: body.data.title,
      type: body.data.type ?? null,
    }).returning();

    await publish(db, {
      id:         newId("evt"),
      kind:       "thread.created",
      repoId:  thread.repoId,
      targetType: "thread",
      targetId:   thread.id,
      actorId:    request.agent?.id,
      payload:    { thread },
      createdAt:  thread.createdAt.toISOString(),
    });

    return reply.status(201).send({ data: thread });
  });

  fastify.get<{ Querystring: { repoId?: string; type?: string; archived?: string } }>("/threads", async (request, reply) => {
    const { repoId, type, archived } = request.query;

    const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof inArray> | ReturnType<typeof isNull>> = [];
    if (repoId) conditions.push(eq(threads.repoId, repoId));
    if (type)      conditions.push(eq(threads.type, type));
    // Archived threads are hidden from the default live view; archived=true to include.
    if (archived !== "true") conditions.push(isNull(threads.archivedAt));
    // Private to their two participants; never part of a repo-wide listing.
    conditions.push(isNull(threads.dmKey));

    if (request.agent) {
      conditions.push(eq(threads.repoId, request.agent.repoId));
    } else if (request.ownerId) {
      const ownedRepoIds = (await db
        .select({ id: repos.id })
        .from(repos)
        .where(eq(repos.ownerId, request.ownerId))).map((p) => p.id);
      if (ownedRepoIds.length === 0) return { data: [] };
      conditions.push(inArray(threads.repoId, ownedRepoIds));
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
        repoId: threads.repoId,
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

    // Deleting a DM would take the other participant's copy with it, and
    // archive already means "make it go away". Operator paths keep it.
    if (scope.thread.type === "dm" && request.agent) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "A direct message thread cannot be deleted. Conclude and archive it instead." },
      });
    }

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
      repoId:  thread.repoId,
      targetType: "thread",
      targetId:   thread.id,
      actorId:    request.agent?.id,
      payload:    { thread },
      createdAt:  new Date().toISOString(),
    });

    return { data: thread };
  });

  // Archive a concluded thread out of the default live views. Works on any
  // thread type — including operational (non-"plan") threads, which previously
  // had no close-and-hide path (conclude_plan is plan-only). The thread must be
  // concluded first; the row + messages stay queryable via archived=true. Idempotent.
  fastify.put<{ Params: { id: string } }>("/threads/:id/archive", async (request, reply) => {
    const scope = await loadThreadScoped(request, db, request.params.id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Thread not found" } });

    if (scope.thread.status !== "concluded") {
      return reply.status(409).send({
        error: { code: "conflict", message: `Only a concluded thread can be archived (status: ${scope.thread.status})` },
      });
    }

    const [updated] = await db
      .update(threads)
      .set({ archivedAt: scope.thread.archivedAt ?? new Date() })
      .where(eq(threads.id, scope.thread.id))
      .returning();

    return { data: updated };
  });
};
