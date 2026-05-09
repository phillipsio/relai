import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { tasks, projects, agents } from "@getrelai/db";
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
  // Optional verification predicate. When set, the `completed` transition is
  // gated: the API rewrites status to `pending_verification` and the
  // scheduler runs the predicate. Exit 0 promotes to `completed`; anything
  // else returns to `assigned`. The predicate is fixed at create time.
  // Three kinds:
  //   - "shell"            — runs `verifyCommand` (legacy default; kept for
  //                          back-compat when only `verifyCommand` is sent).
  //   - "file_exists"      — checks `verifyPath`; no shell exec.
  //   - "thread_concluded" — passes when `verifyThreadId`'s status is
  //                          "concluded"; useful for plan-driven flows.
  //   - "reviewer_agent"   — passes when `verifyReviewerId` posts an "approve"
  //                          decision via POST /tasks/:id/review.
  verifyKind:      z.enum(["shell", "file_exists", "thread_concluded", "reviewer_agent"]).optional(),
  verifyCommand:   z.string().min(1).optional(),
  verifyCwd:       z.string().optional(),
  verifyPath:      z.string().min(1).optional(),
  verifyThreadId:  z.string().min(1).optional(),
  verifyReviewerId: z.string().min(1).optional(),
  // Per-task override for the predicate timeout. Bounded at [1s, 10min];
  // null/undefined falls back to the executor default of 60s.
  verifyTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
})
.refine(
  (v) => {
    if (v.verifyKind === "shell"            && !v.verifyCommand)    return false;
    if (v.verifyKind === "file_exists"      && !v.verifyPath)       return false;
    if (v.verifyKind === "thread_concluded" && !v.verifyThreadId)   return false;
    if (v.verifyKind === "reviewer_agent"   && !v.verifyReviewerId) return false;
    // Non-shell kinds never use verifyCommand — reject mixed config.
    if (
      (v.verifyKind === "file_exists" || v.verifyKind === "thread_concluded" || v.verifyKind === "reviewer_agent") &&
      v.verifyCommand
    ) return false;
    // Reviewer-agent rejects fields that belong to other kinds, and vice versa.
    if (v.verifyKind !== "reviewer_agent"   && v.verifyReviewerId) return false;
    if (v.verifyKind !== "thread_concluded" && v.verifyThreadId)   return false;
    if (v.verifyKind !== "file_exists"      && v.verifyPath)       return false;
    return true;
  },
  { message: "verify config mismatch: each kind requires its own field (shell=verifyCommand, file_exists=verifyPath, thread_concluded=verifyThreadId, reviewer_agent=verifyReviewerId) and fields cannot cross kinds" },
);

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

    // Authoring a shell predicate runs arbitrary commands inside the API
    // process. Restrict to orchestrators and the deprecated admin-secret
    // path. Structured kinds (file_exists, thread_concluded) are unrestricted.
    const authorsShell =
      body.data.verifyKind === "shell" ||
      (body.data.verifyKind === undefined && !!body.data.verifyCommand);
    if (authorsShell && request.agent && request.agent.role !== "orchestrator") {
      return reply.status(403).send({
        error: {
          code: "forbidden",
          message: "Only orchestrator agents may author shell verifyCommand. Use verifyKind=file_exists or verifyKind=thread_concluded for structured predicates.",
        },
      });
    }

    // Reviewer-agent kind: confirm the named reviewer is an agent in the same
    // project. Catches typos and prevents pointing at agents from other tenants.
    if (body.data.verifyKind === "reviewer_agent") {
      const [reviewer] = await db
        .select({ id: agents.id, projectId: agents.projectId })
        .from(agents)
        .where(eq(agents.id, body.data.verifyReviewerId!));
      if (!reviewer || reviewer.projectId !== body.data.projectId) {
        return reply.status(400).send({
          error: { code: "validation_error", message: "verifyReviewerId must reference an agent in the same project" },
        });
      }
    }

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

    // Verification gate: if the task has any verification predicate configured
    // and the caller is trying to mark it completed (and it isn't already
    // verifying / completed), rewrite the transition to pending_verification.
    // The scheduler will run the predicate on the next tick.
    const updates: Record<string, unknown> = { ...body.data };
    let reviewerToNotify: string | null = null;
    if (updates.status === "completed") {
      const [existing] = await db
        .select({
          verifyKind:       tasks.verifyKind,
          verifyCommand:    tasks.verifyCommand,
          verifyPath:       tasks.verifyPath,
          verifyThreadId:   tasks.verifyThreadId,
          verifyReviewerId: tasks.verifyReviewerId,
          status:           tasks.status,
        })
        .from(tasks)
        .where(eq(tasks.id, request.params.id));
      const hasVerify =
        existing?.verifyKind === "file_exists"      ? !!existing.verifyPath       :
        existing?.verifyKind === "thread_concluded" ? !!existing.verifyThreadId   :
        existing?.verifyKind === "reviewer_agent"   ? !!existing.verifyReviewerId :
        !!existing?.verifyCommand;  // shell (or legacy null+command)
      if (
        hasVerify &&
        existing!.status !== "pending_verification" &&
        existing!.status !== "completed"
      ) {
        updates.status = "pending_verification";
        if (existing!.verifyKind === "reviewer_agent") {
          reviewerToNotify = existing!.verifyReviewerId;
        }
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

    // Reviewer-agent kind: nudge the reviewer with a dedicated event and
    // ensure they're subscribed to the task so the SSE stream picks it up.
    if (reviewerToNotify) {
      await ensureSubscription(db, reviewerToNotify, "task", task.id);
      await publish(db, {
        id:         newId("evt"),
        kind:       "task.review_requested",
        projectId:  task.projectId,
        targetType: "task",
        targetId:   task.id,
        alsoNotify: [{ targetType: "agent", targetId: reviewerToNotify }],
        payload:    { task, reviewerId: reviewerToNotify },
        createdAt:  task.updatedAt.toISOString(),
      });
    }

    return { data: task };
  });

  // ── Reviewer-agent decision endpoint ──────────────────────────────────────
  // Records an approve/reject decision from the reviewer named in
  // `tasks.verifyReviewerId`. The decision lands in metadata.review; the
  // verify scheduler picks it up on its next tick and either promotes the
  // task to `completed` or returns it to `assigned`.
  const reviewSchema = z.object({
    decision: z.enum(["approve", "reject"]),
    note:     z.string().max(2_000).optional(),
  });

  fastify.post<{ Params: { id: string } }>("/tasks/:id/review", async (request, reply) => {
    if (!request.agent) {
      return reply.status(403).send({ error: { code: "forbidden", message: "review requires an authenticated agent" } });
    }
    const body = reviewSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, request.params.id));
    if (!task) return reply.status(404).send({ error: { code: "not_found", message: "Task not found" } });
    if (task.verifyKind !== "reviewer_agent" || !task.verifyReviewerId) {
      return reply.status(400).send({ error: { code: "wrong_kind", message: "task does not use reviewer_agent verification" } });
    }
    if (task.verifyReviewerId !== request.agent.id) {
      return reply.status(403).send({ error: { code: "forbidden", message: "only the named reviewer may submit a decision" } });
    }
    if (task.status !== "pending_verification") {
      return reply.status(409).send({ error: { code: "wrong_state", message: `task is ${task.status}; reviews accepted only in pending_verification` } });
    }

    const review = {
      decision:   body.data.decision,
      reviewerId: request.agent.id,
      decidedAt:  new Date().toISOString(),
      ...(body.data.note ? { note: body.data.note } : {}),
    };
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const [updated] = await db.update(tasks)
      .set({ metadata: { ...meta, review }, updatedAt: new Date() })
      .where(eq(tasks.id, task.id))
      .returning();

    await publish(db, {
      id:         newId("evt"),
      kind:       "task.review_submitted",
      projectId:  task.projectId,
      targetType: "task",
      targetId:   task.id,
      alsoNotify: task.assignedTo ? [{ targetType: "agent", targetId: task.assignedTo }] : [],
      payload:    { task: updated, review },
      createdAt:  updated.updatedAt.toISOString(),
    });

    return { data: updated };
  });
};
