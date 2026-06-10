import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and, inArray, asc } from "drizzle-orm";
import { tasks, projects, agents, threads, messages } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { publish, ensureSubscription } from "../lib/events.js";
import { assertProjectAccess } from "../lib/ownership.js";
import { verifyTask } from "../lib/router/scheduler.js";
import type { Db } from "@getrelai/db";
import type { TaskStatus } from "@getrelai/types";

// Lookup a task and verify the caller may access its project. Returns 404 to
// avoid leaking task existence across tenants.
async function loadTaskScoped(request: import("fastify").FastifyRequest, db: Db, taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return { ok: false as const, status: 404 as const };
  const access = await assertProjectAccess(request, db, task.projectId);
  if (!access.ok) return { ok: false as const, status: 404 as const };
  return { ok: true as const, task };
}

// Verify-predicate consistency: each kind requires its own field, and fields
// cannot cross kinds. Shared by create (validates the full object) and update
// (validates the merged existing+patch config) so both paths enforce identically.
function verifyConfigConsistent(v: {
  verifyKind?: string | null;
  verifyCommand?: string | null;
  verifyPath?: string | null;
  verifyThreadId?: string | null;
  verifyReviewerId?: string | null;
}): boolean {
  if (v.verifyKind === "shell"            && !v.verifyCommand)    return false;
  if (v.verifyKind === "file_exists"      && !v.verifyPath)       return false;
  if (v.verifyKind === "thread_concluded" && !v.verifyThreadId)   return false;
  if (v.verifyKind === "reviewer_agent"   && !v.verifyReviewerId) return false;
  if (
    (v.verifyKind === "file_exists" || v.verifyKind === "thread_concluded" || v.verifyKind === "reviewer_agent") &&
    v.verifyCommand
  ) return false;
  if (v.verifyKind !== "reviewer_agent"   && v.verifyReviewerId) return false;
  if (v.verifyKind !== "thread_concluded" && v.verifyThreadId)   return false;
  if (v.verifyKind !== "file_exists"      && v.verifyPath)       return false;
  return true;
}

// Lazily create (and link) the comment thread for an Issue. In the unified UI a
// task's discussion lives on a linked thread; it's created on first access so
// issues nobody comments on don't spawn empty threads. Idempotent: returns the
// existing linked thread if present.
async function ensureTaskThread(db: Db, task: typeof tasks.$inferSelect) {
  if (task.threadId) {
    const [existing] = await db.select().from(threads).where(eq(threads.id, task.threadId));
    if (existing) return existing;
  }
  const [thread] = await db.insert(threads).values({
    id:        newId("thread"),
    projectId: task.projectId,
    title:     task.title,
    type:      null,
    taskId:    task.id,
  }).returning();
  await db.update(tasks).set({ threadId: thread.id, updatedAt: new Date() }).where(eq(tasks.id, task.id));
  return thread;
}

const VERIFY_MISMATCH_MSG =
  "verify config mismatch: each kind requires its own field (shell=verifyCommand, file_exists=verifyPath, thread_concluded=verifyThreadId, reviewer_agent=verifyReviewerId) and fields cannot cross kinds";

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
  // Parent Epic (a "plan" thread) this Issue is spawned from. Optional.
  epicId:         z.string().optional(),
  metadata:       z.record(z.unknown()).default({}),
  // Optional verification predicate. When set, the `completed` transition is
  // gated: the API rewrites status to `pending_verification` and the
  // scheduler runs the predicate. Exit 0 promotes to `completed`; anything
  // else returns to `assigned`. The predicate can be edited after creation via
  // PUT /tasks/:id (e.g. re-point verifyReviewerId); the merged config is
  // re-validated and the shell-author gate re-applied.
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
.refine(verifyConfigConsistent, { message: VERIFY_MISMATCH_MSG });

const updateSchema = z.object({
  title:          z.string().min(1).optional(),
  description:    z.string().min(1).optional(),
  status:         z.enum(["pending", "assigned", "in_progress", "pending_verification", "completed", "blocked", "cancelled"]).optional(),
  priority:       z.enum(["low", "normal", "high", "urgent"]).optional(),
  assignedTo:     z.string().nullable().optional(),
  domains:        z.array(z.string()).optional(),
  epicId:         z.string().nullable().optional(),
  threadId:       z.string().nullable().optional(),
  metadata:       z.record(z.unknown()).optional(),
  // Verification predicate can be edited after creation (e.g. re-point a
  // reviewer). The PUT handler validates the merged config + re-applies the
  // shell-author gate and reviewer-existence check. Fields cannot cross kinds.
  verifyKind:       z.enum(["shell", "file_exists", "thread_concluded", "reviewer_agent"]).optional(),
  verifyCommand:    z.string().min(1).optional(),
  verifyCwd:        z.string().optional(),
  verifyPath:       z.string().min(1).optional(),
  verifyThreadId:   z.string().min(1).optional(),
  verifyReviewerId: z.string().min(1).optional(),
  verifyTimeoutMs:  z.number().int().min(1_000).max(600_000).optional(),
});

export const taskRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post("/tasks", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const access = await assertProjectAccess(request, db, body.data.projectId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Project not found" } });

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

    // Propose-vs-commit fork. Committing work (giving it an owner + entering the
    // lifecycle) is the orchestrator's act. The deprecated admin-secret path
    // (no request.agent) stands in for the orchestrator. A plain worker's create
    // is a *proposal*: it lands in "proposed", inert to the schedulers, with its
    // suggested assignee kept as a non-binding hint. Same predicate the shell
    // gate above uses.
    const canCommit = !request.agent || request.agent.role === "orchestrator";

    let autoAssign: boolean;
    let assignedTo: string | undefined;
    let status: TaskStatus;
    let metadata = body.data.metadata as Record<string, unknown>;

    if (canCommit) {
      // "@auto" means "let the routing scheduler pick" — leave assignee null,
      // flag the task for auto-assignment, and keep status "pending".
      autoAssign = effective === "@auto";
      assignedTo = autoAssign ? undefined : effective;
      status     = body.data.status ?? (assignedTo ? "assigned" : "pending");
    } else {
      // Worker proposal: withhold ownership, ignore any client-supplied status,
      // and stash the suggested assignee for the orchestrator to honor on commit.
      autoAssign = false;
      assignedTo = undefined;
      status     = "proposed";
      metadata   = { ...metadata, proposal: { suggestedAssignee: effective ?? null } };
    }

    const [task] = await db.insert(tasks).values({
      id: newId("task"),
      ...body.data,
      assignedTo,
      autoAssign,
      status,
      metadata,
    }).returning();

    await ensureSubscription(db, body.data.createdBy, "task", task.id);

    if (status === "proposed") {
      // Notify + auto-subscribe every orchestrator in the project so the
      // proposal lands on a triage queue rather than relying on assignment.
      const orchestrators = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.projectId, task.projectId), eq(agents.role, "orchestrator")));
      for (const o of orchestrators) await ensureSubscription(db, o.id, "task", task.id);
      await publish(db, {
        id:         newId("evt"),
        kind:       "task.proposed",
        projectId:  task.projectId,
        targetType: "task",
        targetId:   task.id,
        alsoNotify: orchestrators.map((o) => ({ targetType: "agent", targetId: o.id })),
        payload:    { task, proposedBy: task.createdBy },
        createdAt:  task.createdAt.toISOString(),
      });
    } else {
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
    }

    return reply.status(201).send({ data: task });
  });

  fastify.get<{ Querystring: { projectId?: string; status?: string; assignedTo?: string; epicId?: string } }>(
    "/tasks",
    async (request, reply) => {
      const { projectId, status, assignedTo, epicId } = request.query;

      const conditions = [];
      if (projectId)  conditions.push(eq(tasks.projectId, projectId));
      if (assignedTo) conditions.push(eq(tasks.assignedTo, assignedTo));
      if (epicId)     conditions.push(eq(tasks.epicId, epicId));
      if (status) {
        const statuses = status.split(",") as Array<typeof tasks.status._.data>;
        conditions.push(inArray(tasks.status, statuses));
      }

      // Per-agent caller: scope to the agent's project.
      if (request.agent) {
        conditions.push(eq(tasks.projectId, request.agent.projectId));
      } else if (request.ownerId) {
        // Service-admin: scope to projects owned by this tenant.
        const ownedProjectIds = (await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.ownerId, request.ownerId))).map((p) => p.id);
        if (ownedProjectIds.length === 0) return { data: [] };
        conditions.push(inArray(tasks.projectId, ownedProjectIds));
      }

      const rows = conditions.length > 0
        ? await db.select().from(tasks).where(and(...conditions))
        : await db.select().from(tasks);

      return { data: rows };
    }
  );

  fastify.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const result = await loadTaskScoped(request, db, request.params.id);
    if (!result.ok) return reply.status(result.status).send({ error: { code: "not_found", message: "Task not found" } });
    return { data: result.task };
  });

  fastify.put<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const body = updateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const scope = await loadTaskScoped(request, db, request.params.id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Task not found" } });

    // If this update edits the verification predicate, validate the RESULTING
    // (existing + patch) config exactly like create, and re-apply the
    // shell-author gate + reviewer-existence check. Lets callers re-point a
    // reviewer or swap a predicate kind without dropping to raw SQL.
    const touchesVerify =
      "verifyKind" in body.data || "verifyCommand" in body.data || "verifyCwd" in body.data ||
      "verifyPath" in body.data || "verifyThreadId" in body.data || "verifyReviewerId" in body.data ||
      "verifyTimeoutMs" in body.data;
    if (touchesVerify) {
      const existing = scope.task;
      const merged = {
        verifyKind:       body.data.verifyKind       ?? existing.verifyKind,
        verifyCommand:    body.data.verifyCommand     ?? existing.verifyCommand,
        verifyPath:       body.data.verifyPath        ?? existing.verifyPath,
        verifyThreadId:   body.data.verifyThreadId    ?? existing.verifyThreadId,
        verifyReviewerId: body.data.verifyReviewerId  ?? existing.verifyReviewerId,
      };
      if (!verifyConfigConsistent(merged)) {
        return reply.status(400).send({ error: { code: "validation_error", message: VERIFY_MISMATCH_MSG } });
      }
      const authorsShell = merged.verifyKind === "shell" || (merged.verifyKind == null && !!merged.verifyCommand);
      if (authorsShell && request.agent && request.agent.role !== "orchestrator") {
        return reply.status(403).send({ error: { code: "forbidden", message: "Only orchestrator agents may author shell verifyCommand." } });
      }
      if (merged.verifyKind === "reviewer_agent") {
        const [reviewer] = await db
          .select({ id: agents.id, projectId: agents.projectId })
          .from(agents)
          .where(eq(agents.id, merged.verifyReviewerId!));
        if (!reviewer || reviewer.projectId !== existing.projectId) {
          return reply.status(400).send({ error: { code: "validation_error", message: "verifyReviewerId must reference an agent in the same project" } });
        }
      }
    }

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
    const body = reviewSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const scope = await loadTaskScoped(request, db, request.params.id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Task not found" } });
    const task = scope.task;
    if (task.verifyKind !== "reviewer_agent" || !task.verifyReviewerId) {
      return reply.status(400).send({ error: { code: "wrong_kind", message: "task does not use reviewer_agent verification" } });
    }
    // Accept a decision from any active, pre-terminal state. If the task isn't
    // already pending_verification (e.g. the worker hasn't transitioned it), the
    // decision below also moves it there so the verify scheduler resolves it on
    // its next tick — removing the "worker must flip to pending_verification
    // before the reviewer can sign off" handoff that stranded tasks.
    const REVIEWABLE = ["assigned", "in_progress", "pending_verification"];
    if (!REVIEWABLE.includes(task.status)) {
      return reply.status(409).send({ error: { code: "wrong_state", message: `task is ${task.status}; reviews accepted only from ${REVIEWABLE.join("/")}` } });
    }

    // Authorization: the named reviewer agent always wins. The deprecated
    // admin-secret path (no request.agent attached) is also accepted so the
    // self-hosted dashboard can stand in as a human reviewer; the recorded
    // reviewerId stays the named verifyReviewerId so audit semantics line up
    // with the agent-driven path. Anything else is rejected.
    const isNamedReviewer = !!request.agent && task.verifyReviewerId === request.agent.id;
    const isAdminOverride = !request.agent;
    if (!isNamedReviewer && !isAdminOverride) {
      return reply.status(403).send({ error: { code: "forbidden", message: "only the named reviewer may submit a decision" } });
    }
    if (isAdminOverride) {
      console.warn(`[tasks] /tasks/${task.id}/review submitted via deprecated admin-secret on behalf of ${task.verifyReviewerId}`);
    }

    const review = {
      decision:   body.data.decision,
      reviewerId: task.verifyReviewerId,
      decidedAt:  new Date().toISOString(),
      // Owner-authenticated callers (service-admin + X-Owner-Id, no agent) are
      // recorded by their owner id; the bare "admin" sentinel is only the
      // deprecated shared-secret path with no owner context.
      ...(isAdminOverride ? { submittedBy: request.ownerId ?? "admin" } : {}),
      ...(body.data.note ? { note: body.data.note } : {}),
    };
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const [updated] = await db.update(tasks)
      .set({
        metadata: { ...meta, review },
        updatedAt: new Date(),
        // Park it in pending_verification (if it isn't already) so the verify
        // scheduler picks up the recorded decision and promotes/returns it.
        ...(task.status !== "pending_verification" ? { status: "pending_verification" as const } : {}),
      })
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

    // Resolve the decision synchronously so the caller gets the final state
    // (completed on approve, assigned on reject) without waiting for the next
    // scheduler tick. If the row isn't claimable here (e.g. the scheduler is
    // mid-tick on it), it falls through and the scheduler finishes the job.
    await verifyTask(db, task.id);
    const [resolved] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    return { data: resolved ?? updated };
  });

  // ── Commit / reject a proposal ────────────────────────────────────────────
  // A worker's create_task lands in "proposed"; committing it (assigning an
  // owner and entering the lifecycle) is the orchestrator's act. The orchestrator
  // may ratify edits in the same call and must re-validate any verify changes.
  // Reject cancels the proposal and notifies the proposer.
  const commitSchema = z.object({
    decision:       z.enum(["commit", "reject"]).default("commit"),
    assignedTo:     z.string().optional(),         // agent id | "@auto" | omit→project default
    note:           z.string().max(2_000).optional(),
    epicId:         z.string().optional(),
    // Optional ratified edits the orchestrator applies as it commits.
    title:          z.string().min(1).optional(),
    description:    z.string().min(1).optional(),
    priority:       z.enum(["low", "normal", "high", "urgent"]).optional(),
    domains:        z.array(z.string()).optional(),
    specialization: z.string().optional(),
    verifyKind:       z.enum(["shell", "file_exists", "thread_concluded", "reviewer_agent"]).optional(),
    verifyCommand:    z.string().min(1).optional(),
    verifyCwd:        z.string().optional(),
    verifyPath:       z.string().min(1).optional(),
    verifyThreadId:   z.string().min(1).optional(),
    verifyReviewerId: z.string().min(1).optional(),
    verifyTimeoutMs:  z.number().int().min(1_000).max(600_000).optional(),
  });

  fastify.post<{ Params: { id: string } }>("/tasks/:id/commit", async (request, reply) => {
    const body = commitSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const scope = await loadTaskScoped(request, db, request.params.id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Task not found" } });
    const task = scope.task;

    // Only a proposal can be committed.
    if (task.status !== "proposed") {
      return reply.status(409).send({ error: { code: "wrong_state", message: `task is ${task.status}; only 'proposed' tasks can be committed` } });
    }

    // Commit is an orchestrator act; the admin-secret path stands in for one.
    const canCommit = !request.agent || request.agent.role === "orchestrator";
    if (!canCommit) {
      return reply.status(403).send({ error: { code: "forbidden", message: "only an orchestrator may commit a proposed task" } });
    }

    // Prefer the agent id, then the owner id (operator ingress), falling back to
    // the bare "admin" sentinel only for the deprecated shared-secret path.
    const committedBy = request.agent?.id ?? request.ownerId ?? "admin";
    const meta = (task.metadata ?? {}) as Record<string, unknown>;

    if (body.data.decision === "reject") {
      const proposal = (meta.proposal ?? {}) as Record<string, unknown>;
      const [rejected] = await db.update(tasks)
        .set({
          status: "cancelled",
          metadata: { ...meta, proposal: { ...proposal, rejectedBy: committedBy, rejectedAt: new Date().toISOString(), ...(body.data.note ? { note: body.data.note } : {}) } },
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id))
        .returning();
      await publish(db, {
        id:         newId("evt"),
        kind:       "task.proposal_rejected",
        projectId:  task.projectId,
        targetType: "task",
        targetId:   task.id,
        alsoNotify: [{ targetType: "agent", targetId: task.createdBy }],
        payload:    { task: rejected, rejectedBy: committedBy, note: body.data.note },
        createdAt:  rejected.updatedAt.toISOString(),
      });
      return { data: rejected };
    }

    // Re-validate any verify edits against the merged (existing + patch) config,
    // mirroring PUT /tasks/:id. The shell-author gate is moot here (committers
    // are orchestrators), but cross-kind and reviewer-existence checks still apply.
    const touchesVerify =
      "verifyKind" in body.data || "verifyCommand" in body.data || "verifyCwd" in body.data ||
      "verifyPath" in body.data || "verifyThreadId" in body.data || "verifyReviewerId" in body.data ||
      "verifyTimeoutMs" in body.data;
    if (touchesVerify) {
      const merged = {
        verifyKind:       body.data.verifyKind       ?? task.verifyKind,
        verifyCommand:    body.data.verifyCommand     ?? task.verifyCommand,
        verifyPath:       body.data.verifyPath        ?? task.verifyPath,
        verifyThreadId:   body.data.verifyThreadId    ?? task.verifyThreadId,
        verifyReviewerId: body.data.verifyReviewerId  ?? task.verifyReviewerId,
      };
      if (!verifyConfigConsistent(merged)) {
        return reply.status(400).send({ error: { code: "validation_error", message: VERIFY_MISMATCH_MSG } });
      }
      if (merged.verifyKind === "reviewer_agent") {
        const [reviewer] = await db
          .select({ id: agents.id, projectId: agents.projectId })
          .from(agents)
          .where(eq(agents.id, merged.verifyReviewerId!));
        if (!reviewer || reviewer.projectId !== task.projectId) {
          return reply.status(400).send({ error: { code: "validation_error", message: "verifyReviewerId must reference an agent in the same project" } });
        }
      }
    }

    // Resolve the effective assignee: explicit wins, else the project default.
    let effective = body.data.assignedTo;
    if (effective === undefined) {
      const [project] = await db
        .select({ defaultAssignee: projects.defaultAssignee })
        .from(projects)
        .where(eq(projects.id, task.projectId));
      effective = project?.defaultAssignee ?? undefined;
    }
    const autoAssign = effective === "@auto";
    const assignedTo = autoAssign ? undefined : effective ?? null;
    const status = assignedTo ? "assigned" : "pending";

    // Editable fields the orchestrator may ratify (omit assignment/decision/note).
    const { decision: _d, assignedTo: _a, note: _n, ...edits } = body.data;

    const [committed] = await db.update(tasks)
      .set({
        ...edits,
        assignedTo,
        autoAssign,
        status,
        metadata: { ...meta, commit: { committedBy, committedAt: new Date().toISOString() } },
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id))
      .returning();

    if (committed.assignedTo) await ensureSubscription(db, committed.assignedTo, "task", committed.id);
    await publish(db, {
      id:         newId("evt"),
      kind:       "task.committed",
      projectId:  committed.projectId,
      targetType: "task",
      targetId:   committed.id,
      alsoNotify: committed.assignedTo ? [{ targetType: "agent", targetId: committed.assignedTo }] : [],
      payload:    { task: committed, committedBy },
      createdAt:  committed.updatedAt.toISOString(),
    });

    return { data: committed };
  });

  // ── Issue comments (the unified-UI view of a task's linked thread) ─────────
  // Reads/posts comments against the task's lazily-created comment thread, so the
  // web Issue detail doesn't have to manage thread creation itself.
  fastify.get<{ Params: { id: string } }>("/tasks/:id/comments", async (request, reply) => {
    const scope = await loadTaskScoped(request, db, request.params.id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Task not found" } });
    const thread = await ensureTaskThread(db, scope.task);
    const rows = await db.select().from(messages).where(eq(messages.threadId, thread.id)).orderBy(asc(messages.createdAt));
    return { data: { threadId: thread.id, comments: rows } };
  });

  const commentSchema = z.object({
    body: z.string().min(1),
    type: z.enum(["status", "handoff", "finding", "decision", "question", "escalation", "reply"]).optional(),
  });

  fastify.post<{ Params: { id: string } }>("/tasks/:id/comments", async (request, reply) => {
    const body = commentSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const scope = await loadTaskScoped(request, db, request.params.id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Task not found" } });
    const thread = await ensureTaskThread(db, scope.task);

    // Caller identity, or "human" for the deprecated admin-secret path (matches
    // the dashboard's "reply as human" semantics on the old Threads page).
    const fromAgent = request.agent?.id ?? "human";
    const [message] = await db.insert(messages).values({
      id:        newId("msg"),
      threadId:  thread.id,
      fromAgent,
      type:      body.data.type ?? "status",
      body:      body.data.body,
    }).returning();

    // Only real agents get a subscription row (agentId has an FK); the "human"
    // admin path is the dashboard, which reads via polling, not SSE.
    if (request.agent) await ensureSubscription(db, request.agent.id, "thread", thread.id);
    await publish(db, {
      id:         newId("evt"),
      kind:       "message.posted",
      projectId:  thread.projectId,
      targetType: "thread",
      targetId:   thread.id,
      alsoNotify: scope.task.assignedTo ? [{ targetType: "agent", targetId: scope.task.assignedTo }] : [],
      payload:    { message },
      createdAt:  message.createdAt.toISOString(),
    });

    return reply.status(201).send({ data: message });
  });
};
