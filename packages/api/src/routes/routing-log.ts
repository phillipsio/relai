import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { routingLog, tasks, repos } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { assertRepoAccess } from "../lib/ownership.js";
import type { Db } from "@getrelai/db";

const createSchema = z.object({
  taskId:     z.string(),
  assignedTo: z.string(),
  method:     z.enum(["rules", "claude"]),
  rationale:  z.string(),
});

export const routingLogRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post("/routing-log", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    // The task must belong to a project the caller can access.
    const [task] = await db.select({ repoId: tasks.repoId }).from(tasks).where(eq(tasks.id, body.data.taskId));
    if (!task) return reply.status(404).send({ error: { code: "not_found", message: "Task not found" } });
    const access = await assertRepoAccess(request, db, task.repoId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: "not_found", message: "Task not found" } });

    const [entry] = await db.insert(routingLog).values({
      id:         newId("rlog"),
      taskId:     body.data.taskId,
      assignedTo: body.data.assignedTo,
      method:     body.data.method,
      rationale:  body.data.rationale,
    }).returning();

    return reply.status(201).send({ data: entry });
  });

  fastify.get<{ Querystring: { taskId?: string; assignedTo?: string } }>(
    "/routing-log",
    async (request, reply) => {
      const { taskId, assignedTo } = request.query;

      const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof inArray>> = [];
      if (taskId) conditions.push(eq(routingLog.taskId, taskId));
      if (assignedTo) conditions.push(eq(routingLog.assignedTo, assignedTo));

      // Tenant-scope: limit to routing rows whose task is in the caller's
      // visible repos. API_SECRET path skips the filter.
      if (request.agent) {
        const inScope = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.repoId, request.agent.repoId))).map((t) => t.id);
        if (inScope.length === 0) return { data: [] };
        conditions.push(inArray(routingLog.taskId, inScope));
      } else if (request.ownerId) {
        const ownedRepoIds = (await db.select({ id: repos.id }).from(repos).where(eq(repos.ownerId, request.ownerId))).map((p) => p.id);
        if (ownedRepoIds.length === 0) return { data: [] };
        const inScope = (await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.repoId, ownedRepoIds))).map((t) => t.id);
        if (inScope.length === 0) return { data: [] };
        conditions.push(inArray(routingLog.taskId, inScope));
      }

      const rows = conditions.length === 0
        ? await db.select().from(routingLog)
        : conditions.length === 1
        ? await db.select().from(routingLog).where(conditions[0])
        : await db.select().from(routingLog).where(and(...conditions));

      return { data: rows };
    }
  );
};
