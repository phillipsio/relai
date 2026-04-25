import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { projects, agents, threads, messages, tasks, routingLog } from "@relai/db";
import { newId } from "../lib/id.js";
import type { Db } from "@relai/db";

const createSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().url().optional(),
  description: z.string().optional(),
  routingMode: z.enum(["automated", "manual"]).optional(),
});

export const projectRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.get("/projects", async () => {
    const rows = await db.select().from(projects);
    return { data: rows };
  });

  fastify.post("/projects", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const [project] = await db.insert(projects).values({
      id: newId("proj"),
      name: body.data.name,
      repoUrl: body.data.repoUrl,
      description: body.data.description,
      routingMode: body.data.routingMode ?? null,
    }).returning();

    return reply.status(201).send({ data: project });
  });

  fastify.get<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const [project] = await db.select().from(projects).where(eq(projects.id, request.params.id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Project not found" } });
    return { data: project };
  });

  fastify.delete<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const { id } = request.params;
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Project not found" } });

    // Cascade manually in dependency order
    const threadIds = (await db.select({ id: threads.id }).from(threads).where(eq(threads.projectId, id))).map((t) => t.id);
    if (threadIds.length > 0) await db.delete(messages).where(inArray(messages.threadId, threadIds));
    await db.delete(threads).where(eq(threads.projectId, id));

    const taskIds = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, id))).map((t) => t.id);
    if (taskIds.length > 0) await db.delete(routingLog).where(inArray(routingLog.taskId, taskIds));
    await db.delete(tasks).where(eq(tasks.projectId, id));

    await db.delete(agents).where(eq(agents.projectId, id));
    await db.delete(projects).where(eq(projects.id, id));

    return reply.status(204).send();
  });
};
