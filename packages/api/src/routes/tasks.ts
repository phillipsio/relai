import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { tasks } from "@relai/db";
import { newId } from "../lib/id.js";
import type { Db } from "@relai/db";

const createSchema = z.object({
  projectId:      z.string(),
  createdBy:      z.string(),
  title:          z.string().min(1),
  description:    z.string().min(1),
  priority:       z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  domains:        z.array(z.string()).default([]),
  specialization: z.string().optional(),
  metadata:       z.record(z.unknown()).default({}),
});

const updateSchema = z.object({
  title:          z.string().min(1).optional(),
  description:    z.string().min(1).optional(),
  status:         z.enum(["pending", "assigned", "in_progress", "completed", "blocked", "cancelled"]).optional(),
  priority:       z.enum(["low", "normal", "high", "urgent"]).optional(),
  assignedTo:     z.string().nullable().optional(),
  domains:        z.array(z.string()).optional(),
  metadata:       z.record(z.unknown()).optional(),
});

export const taskRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post("/tasks", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const [task] = await db.insert(tasks).values({
      id: newId("task"),
      ...body.data,
    }).returning();

    return reply.status(201).send({ data: task });
  });

  fastify.get<{ Querystring: { projectId?: string; status?: string; assignedTo?: string } }>(
    "/tasks",
    async (request, reply) => {
      const { projectId, status, assignedTo } = request.query;

      const conditions = [];
      if (projectId)  conditions.push(eq(tasks.projectId, projectId));
      if (assignedTo) conditions.push(eq(tasks.assignedTo, assignedTo));
      if (status) {
        const statuses = status.split(",") as Array<typeof tasks.status._.data>;
        conditions.push(inArray(tasks.status, statuses));
      }

      const rows = conditions.length > 0
        ? await db.select().from(tasks).where(and(...conditions))
        : await db.select().from(tasks);

      return { data: rows };
    }
  );

  fastify.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, request.params.id));
    if (!task) return reply.status(404).send({ error: { code: "not_found", message: "Task not found" } });
    return { data: task };
  });

  fastify.put<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const body = updateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const [task] = await db
      .update(tasks)
      .set({ ...body.data, updatedAt: new Date() })
      .where(eq(tasks.id, request.params.id))
      .returning();

    if (!task) return reply.status(404).send({ error: { code: "not_found", message: "Task not found" } });
    return { data: task };
  });
};
