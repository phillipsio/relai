import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, inArray, and } from "drizzle-orm";
import { repos, agents, threads, messages, tasks, routingLog, verificationLog, invites } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { assertRepoAccess, scopedRepoFilter } from "../lib/ownership.js";
import type { Db } from "@getrelai/db";

const createSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().url().optional(),
  description: z.string().optional(),
  defaultAssignee: z.string().optional(),
  context: z.string().optional(),
});

export const repoRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.get("/repos", async (request) => {
    // Per-agent callers see only their own project; service-admin sees only
    // repos owned by X-Owner-Id; API_SECRET sees everything.
    if (request.agent) {
      const rows = await db.select().from(repos).where(eq(repos.id, request.agent.repoId));
      return { data: rows };
    }
    const filter = scopedRepoFilter(request);
    const rows = filter
      ? await db.select().from(repos).where(filter)
      : await db.select().from(repos);
    return { data: rows };
  });

  fastify.post("/repos", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const [project] = await db.insert(repos).values({
      id: newId("repo"),
      name: body.data.name,
      // Stamp tenant ownership when the closed dashboard provisions a project
      // on behalf of a logged-in user. Null for self-hosted / seed scripts.
      ownerId: request.ownerId ?? null,
      repoUrl: body.data.repoUrl,
      description: body.data.description,
      defaultAssignee: body.data.defaultAssignee ?? null,
      context: body.data.context ?? null,
    }).returning();

    return reply.status(201).send({ data: project });
  });

  fastify.get<{ Params: { id: string } }>("/repos/:id", async (request, reply) => {
    const access = await assertRepoAccess(request, db, request.params.id);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
    const [project] = await db.select().from(repos).where(eq(repos.id, request.params.id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });
    return { data: project };
  });

  const updateSchema = z.object({
    name:            z.string().min(1).optional(),
    description:     z.string().nullable().optional(),
    repoUrl:         z.string().url().nullable().optional(),
    defaultAssignee: z.string().nullable().optional(),
    context:         z.string().nullable().optional(),
  });

  fastify.put<{ Params: { id: string } }>("/repos/:id", async (request, reply) => {
    const body = updateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const access = await assertRepoAccess(request, db, request.params.id);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });

    const [project] = await db
      .update(repos)
      .set(body.data)
      .where(eq(repos.id, request.params.id))
      .returning();

    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });
    return { data: project };
  });

  fastify.delete<{ Params: { id: string } }>("/repos/:id", async (request, reply) => {
    const { id } = request.params;
    const access = await assertRepoAccess(request, db, id);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
    const [project] = await db.select().from(repos).where(eq(repos.id, id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });

    // Cascade manually in dependency order
    const threadIds = (await db.select({ id: threads.id }).from(threads).where(eq(threads.repoId, id))).map((t) => t.id);
    if (threadIds.length > 0) await db.delete(messages).where(inArray(messages.threadId, threadIds));
    await db.delete(threads).where(eq(threads.repoId, id));

    const taskIds = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.repoId, id))).map((t) => t.id);
    if (taskIds.length > 0) {
      await db.delete(routingLog).where(inArray(routingLog.taskId, taskIds));
      await db.delete(verificationLog).where(inArray(verificationLog.taskId, taskIds));
    }
    await db.delete(tasks).where(eq(tasks.repoId, id));

    // invites.createdBy → agents.id has no FK cascade, so invites must be cleared
    // before agents to avoid blocking the agent delete.
    await db.delete(invites).where(eq(invites.repoId, id));
    await db.delete(agents).where(eq(agents.repoId, id));
    await db.delete(repos).where(eq(repos.id, id));

    return reply.status(204).send();
  });
};
