import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { tasks, projects } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { publish, ensureSubscription } from "../lib/events.js";
import type { Db } from "@getrelai/db";

const createSchema = z.object({
  projectId:      z.string(),
  createdBy:      z.string(),
  title:          z.string().min(1),
  description:    z.string().min(1),
  priority:       z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  status:         z.enum(["pending", "assigned", "in_progress", "completed", "blocked", "cancelled"]).optional(),
  // Either an agent ID or the literal "@auto" (defer to routing scheduler).
  assignedTo:     z.string().optional(),
  domains:        z.array(z.string()).default([]),
  specialization: z.string().optional(),
  metadata:       z.record(z.unknown()).default({}),
  // Optional shell predicate. When set, the `completed` transition is gated:
  // the API rewrites status to `pending_verification` and the scheduler runs
  // the command. Exit 0 promotes to `completed`; anything else returns to
  // `assigned`. The predicate is fixed at create time and cannot be changed.
  verifyCommand:  z.string().min(1).optional(),
  verifyCwd:      z.string().optional(),
});

const updateSchema = z.object({
  title:          z.string().min(1).optional(),
  description:    z.string().min(1).optional(),
  status:         z.enum(["pending", "assigned", "in_progress", "pending_verification", "completed", "blocked", "cancelled"]).optional(),
  priority:       z.enum(["low", "normal", "high", "urgent"]).optional(),
  assignedTo:     z.string().nullable().optional(),
  domains:        z.array(z.string()).optional(),
  metadata:       z.record(z.unknown()).optional(),
});

export const taskRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post("/tasks", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    // Resolve effective assignee: explicit value wins, else the project's default.
    let effective = body.data.assignedTo;
    if (effective === undefined) {
      const [project] = await db
        .select({ defaultAssignee: projects.defaultAssignee })
        .from(projects)
        .where(eq(projects.id, body.data.projectId));
      effective = project?.defaultAssignee ?? undefined;
    }

    // "@auto" means "let the routing scheduler pick" — leave assignee null,
    // flag the task for auto-assignment, and keep status "pending".
    const autoAssign = effective === "@auto";
    const assignedTo = autoAssign ? undefined : effective;
    const status = body.data.status ?? (assignedTo ? "assigned" : "pending");

    const [task] = await db.insert(tasks).values({
      id: newId("task"),
      ...body.data,
      assignedTo,
      autoAssign,
      status,
    }).returning();

    await ensureSubscription(db, body.data.createdBy, "task", task.id);
    await publish(db, {
      id:         newId("evt"),
      kind:       "task.created",
      projectId:  task.projectId,
      targetType: "task",
      targetId:   task.id,
      alsoNotify: task.assignedTo ? [{ targetType: "agent", targetId: task.assignedTo }] : [],
      payload:    { task },
      createdAt:  task.createdAt.toISOString(),
    });

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

    // Verification gate: if the task has a verifyCommand and the caller is
    // trying to mark it completed (and it isn't already verifying / completed),
    // rewrite the transition to pending_verification. The scheduler will run
    // the predicate on the next tick.
    const updates: Record<string, unknown> = { ...body.data };
    if (updates.status === "completed") {
      const [existing] = await db
        .select({ verifyCommand: tasks.verifyCommand, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, request.params.id));
      if (
        existing?.verifyCommand &&
        existing.status !== "pending_verification" &&
        existing.status !== "completed"
      ) {
        updates.status = "pending_verification";
      }
    }

    // Clear stalledAt on any update — the row is moving again.
    const [task] = await db
      .update(tasks)
      .set({ ...updates, updatedAt: new Date(), stalledAt: null })
      .where(eq(tasks.id, request.params.id))
      .returning();

    if (!task) return reply.status(404).send({ error: { code: "not_found", message: "Task not found" } });

    await publish(db, {
      id:         newId("evt"),
      kind:       "task.updated",
      projectId:  task.projectId,
      targetType: "task",
      targetId:   task.id,
      alsoNotify: task.assignedTo ? [{ targetType: "agent", targetId: task.assignedTo }] : [],
      payload:    { task, changes: updates },
      createdAt:  task.updatedAt.toISOString(),
    });

    return { data: task };
  });
};
