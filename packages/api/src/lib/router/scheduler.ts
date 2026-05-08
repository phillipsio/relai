import Anthropic from "@anthropic-ai/sdk";
import { eq, and, inArray, isNull, lt, or } from "drizzle-orm";
import { agents, tasks, routingLog, messages, verificationLog } from "@getrelai/db";
import type { Db } from "@getrelai/db";
import { newId } from "../id.js";
import { publish } from "../events.js";
import { runVerification } from "../verify.js";
import type { VerificationResult } from "../verify.js";
import { runFileExistsVerification } from "../verify-file-exists.js";
import { runThreadConcludedVerification } from "../verify-thread-concluded.js";
import { tryRulesRouting } from "./rules.js";
import { claudeRouting } from "./claude.js";

const VERIFY_STUCK_MS = 5 * 60 * 1000;

const TASK_POLL_MS         = Number(process.env.TASK_POLL_MS         ?? 15_000);
const BLOCKED_POLL_MS      = Number(process.env.BLOCKED_POLL_MS      ?? 15_000);
// A task is considered stalled when it's been `in_progress` longer than this
// without any update. Cleared on the next PUT /tasks/:id. Read lazily so tests
// can override via env at runtime.
const stallThresholdMs = () => Number(process.env.STALL_THRESHOLD_MS ?? 4 * 60 * 60 * 1000);

let anthropic: Anthropic | null = null;

function getAnthropic(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

// ── Task routing ──────────────────────────────────────────────────────────────

async function routePendingTasks(db: Db, projectId: string): Promise<void> {
  const pending = await db
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.projectId, projectId),
      eq(tasks.status, "pending"),
      eq(tasks.autoAssign, true),
    ));

  if (pending.length === 0) return;

  const workers = await db
    .select()
    .from(agents)
    .where(and(eq(agents.projectId, projectId), eq(agents.role, "worker")));

  if (workers.length === 0) return;

  // Build load map: count in_progress tasks per agent
  const active = await db
    .select({ assignedTo: tasks.assignedTo })
    .from(tasks)
    .where(and(
      eq(tasks.projectId, projectId),
      inArray(tasks.status, ["assigned", "in_progress"]),
    ));
  const taskCounts: Record<string, number> = {};
  for (const row of active) {
    if (row.assignedTo) taskCounts[row.assignedTo] = (taskCounts[row.assignedTo] ?? 0) + 1;
  }

  const ai = getAnthropic();
  const model = process.env.ROUTING_MODEL ?? "claude-haiku-4-5-20251001";

  for (const task of pending) {
    const taskRow = { ...task, metadata: (task.metadata ?? {}) as Record<string, unknown> };
    let result = tryRulesRouting(taskRow, workers, taskCounts);

    if (!result) {
      if (!ai) {
        console.log(`[scheduler] Task ${task.id} needs Claude routing but ANTHROPIC_API_KEY not set — skipping`);
        continue;
      }
      try {
        result = await claudeRouting(taskRow, workers, ai, model);
      } catch (err) {
        console.error(`[scheduler] Claude routing failed for task ${task.id}:`, err);
        continue;
      }
    }

    if (result.agentId === "UNROUTABLE") {
      console.warn(`[scheduler] Task ${task.id} unroutable: ${result.rationale}`);
      continue;
    }

    await db.update(tasks).set({ status: "assigned", assignedTo: result.agentId }).where(eq(tasks.id, task.id));
    await db.insert(routingLog).values({
      id: newId("route"),
      taskId: task.id,
      assignedTo: result.agentId,
      method: result.method,
      rationale: result.rationale,
    });

    console.log(`[scheduler] ${task.id} → ${result.agentId} (${result.method}): ${result.rationale}`);

    // Update load map so subsequent tasks in this cycle see the updated counts
    taskCounts[result.agentId] = (taskCounts[result.agentId] ?? 0) + 1;
  }
}

// ── Blocked task watch ────────────────────────────────────────────────────────

async function watchBlockedTasks(db: Db, projectId: string): Promise<void> {
  const blocked = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, "blocked")));

  const watchable = blocked.filter(
    (t) => typeof (t.metadata as Record<string, unknown>).blockedThreadId === "string"
  );

  for (const task of watchable) {
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const threadId = meta.blockedThreadId as string;

    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(messages.createdAt);

    const taskCreatedAt = new Date(task.createdAt).getTime();
    const humanReply = msgs.find(
      (m) => m.fromAgent === "human" && new Date(m.createdAt).getTime() > taskCreatedAt
    );

    if (!humanReply) continue;

    console.log(`[scheduler] Human replied to blocked task ${task.id} — resuming`);

    await db.update(tasks).set({
      status: "assigned",
      metadata: { ...meta, humanReply: humanReply.body, humanRepliedAt: humanReply.createdAt },
    }).where(eq(tasks.id, task.id));
  }
}

// ── Stall detection ───────────────────────────────────────────────────────────

export async function detectStalls(db: Db, projectId: string): Promise<void> {
  const thresholdMs = stallThresholdMs();
  const cutoff = new Date(Date.now() - thresholdMs);

  const stalled = await db
    .update(tasks)
    .set({ stalledAt: new Date() })
    .where(and(
      eq(tasks.projectId, projectId),
      eq(tasks.status, "in_progress"),
      isNull(tasks.stalledAt),
      lt(tasks.updatedAt, cutoff),
    ))
    .returning();

  for (const task of stalled) {
    console.warn(`[scheduler] task ${task.id} stalled — in_progress since ${task.updatedAt.toISOString()}`);
    await publish(db, {
      id:         newId("evt"),
      kind:       "task.stalled",
      projectId:  task.projectId,
      targetType: "task",
      targetId:   task.id,
      alsoNotify: task.assignedTo ? [{ targetType: "agent", targetId: task.assignedTo }] : [],
      payload:    { task, stalledAt: task.stalledAt!.toISOString(), thresholdMs },
      createdAt:  task.stalledAt!.toISOString(),
    });
  }
}

// ── Verification ──────────────────────────────────────────────────────────────

type VerifyExec = (command: string, cwd?: string | null, timeoutMs?: number) => Promise<VerificationResult>;

export async function verifyPending(
  db: Db,
  projectId: string,
  exec: VerifyExec = runVerification,
): Promise<void> {
  const stuckCutoff = new Date(Date.now() - VERIFY_STUCK_MS);

  // Identify candidates: unverified `pending_verification` rows, plus any
  // whose claim marker is older than the stuck threshold (treat as crashed).
  const candidates = await db
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.projectId, projectId),
      eq(tasks.status, "pending_verification"),
      or(isNull(tasks.verifyingAt), lt(tasks.verifyingAt, stuckCutoff)),
    ));

  for (const candidate of candidates) {
    const wasStuck = candidate.verifyingAt !== null && candidate.verifyingAt < stuckCutoff;
    // Conditional claim: only succeed if verifyingAt is still what we observed.
    // Prevents another scheduler instance racing on the same row.
    const [task] = await db
      .update(tasks)
      .set({ verifyingAt: new Date() })
      .where(and(
        eq(tasks.id, candidate.id),
        eq(tasks.status, "pending_verification"),
        candidate.verifyingAt === null
          ? isNull(tasks.verifyingAt)
          : eq(tasks.verifyingAt, candidate.verifyingAt),
      ))
      .returning();
    if (!task) continue;

    // Resolve effective predicate. Legacy rows (null kind + verifyCommand)
    // behave as kind="shell".
    const kind = task.verifyKind ?? (task.verifyCommand ? "shell" : null);
    const misconfigured =
      (kind === "shell"            && !task.verifyCommand)  ||
      (kind === "file_exists"      && !task.verifyPath)     ||
      (kind === "thread_concluded" && !task.verifyThreadId) ||
      kind === null;
    if (misconfigured) {
      // Misconfigured row — clear claim and revert to assigned.
      await db.update(tasks)
        .set({ status: "assigned", verifyingAt: null, updatedAt: new Date() })
        .where(eq(tasks.id, task.id));
      continue;
    }

    let result: VerificationResult;
    if (wasStuck) {
      result = {
        exitCode: null,
        stdout: "",
        stderr: `[scheduler] previous verification claim exceeded ${VERIFY_STUCK_MS}ms — treated as crashed`,
        durationMs: 0,
        timedOut: true,
      };
    } else {
      try {
        if (kind === "file_exists") {
          result = await runFileExistsVerification(task.verifyPath!, task.verifyCwd);
        } else if (kind === "thread_concluded") {
          result = await runThreadConcludedVerification(db, task.verifyThreadId!);
        } else {
          result = await exec(task.verifyCommand!, task.verifyCwd, task.verifyTimeoutMs ?? undefined);
        }
      } catch (err) {
        result = {
          exitCode: null,
          stdout: "",
          stderr: `[scheduler] verification crashed: ${(err as Error).message}`,
          durationMs: 0,
          timedOut: false,
        };
      }
    }

    // Synthesize a human-readable command label for the log row. Non-shell
    // kinds don't have a shell command — record the predicate shape instead.
    const logCommand =
      kind === "file_exists"      ? `file_exists:${task.verifyPath}`           :
      kind === "thread_concluded" ? `thread_concluded:${task.verifyThreadId}`  :
      task.verifyCommand!;

    const [logRow] = await db.insert(verificationLog).values({
      id:         newId("verif"),
      taskId:     task.id,
      command:    logCommand,
      exitCode:   result.exitCode,
      stdout:     result.stdout,
      stderr:     result.stderr,
      durationMs: result.durationMs,
      timedOut:   result.timedOut,
    }).returning();

    const passed = result.exitCode === 0 && !result.timedOut;
    if (passed) {
      const [updated] = await db.update(tasks)
        .set({ status: "completed", verifyingAt: null, updatedAt: new Date() })
        .where(eq(tasks.id, task.id))
        .returning();

      console.log(`[scheduler] verified ${task.id} → completed (${result.durationMs}ms)`);
      await publish(db, {
        id:         newId("evt"),
        kind:       "task.verified",
        projectId:  task.projectId,
        targetType: "task",
        targetId:   task.id,
        alsoNotify: updated.assignedTo ? [{ targetType: "agent", targetId: updated.assignedTo }] : [],
        payload:    { task: updated, verification: { logId: logRow.id, durationMs: result.durationMs } },
        createdAt:  updated.updatedAt.toISOString(),
      });
    } else {
      const meta = (task.metadata ?? {}) as Record<string, unknown>;
      const [updated] = await db.update(tasks)
        .set({
          status:     "assigned",
          verifyingAt: null,
          metadata:   {
            ...meta,
            lastVerification: {
              exitCode:   result.exitCode,
              timedOut:   result.timedOut,
              durationMs: result.durationMs,
              logId:      logRow.id,
            },
          },
          updatedAt:  new Date(),
        })
        .where(eq(tasks.id, task.id))
        .returning();

      console.warn(`[scheduler] verification failed for ${task.id} (exit=${result.exitCode}, timeout=${result.timedOut})`);
      await publish(db, {
        id:         newId("evt"),
        kind:       "task.verification_failed",
        projectId:  task.projectId,
        targetType: "task",
        targetId:   task.id,
        alsoNotify: updated.assignedTo ? [{ targetType: "agent", targetId: updated.assignedTo }] : [],
        payload:    {
          task:         updated,
          verification: {
            logId:      logRow.id,
            exitCode:   result.exitCode,
            timedOut:   result.timedOut,
            durationMs: result.durationMs,
          },
        },
        createdAt:  updated.updatedAt.toISOString(),
      });
    }
  }
}

// ── Project-scoped cycle ──────────────────────────────────────────────────────

async function runCycle(db: Db, projectId: string): Promise<void> {
  await Promise.all([
    routePendingTasks(db, projectId).catch((err) =>
      console.error(`[scheduler] routing error project=${projectId}:`, err)
    ),
    watchBlockedTasks(db, projectId).catch((err) =>
      console.error(`[scheduler] blocked-watch error project=${projectId}:`, err)
    ),
    detectStalls(db, projectId).catch((err) =>
      console.error(`[scheduler] stall-detect error project=${projectId}:`, err)
    ),
    verifyPending(db, projectId).catch((err) =>
      console.error(`[scheduler] verify error project=${projectId}:`, err)
    ),
  ]);
}

// ── Startup ───────────────────────────────────────────────────────────────────

export function startRoutingScheduler(db: Db): void {
  async function tick() {
    try {
      // Find every project that currently has work for the scheduler:
      // pending+autoAssign tasks (routing) or blocked tasks with thread metadata
      // (resume watcher). One cycle per affected project.
      const auto = await db
        .selectDistinct({ projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.status, "pending"), eq(tasks.autoAssign, true)));

      const blocked = await db
        .selectDistinct({ projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.status, "blocked"));

      const inProgress = await db
        .selectDistinct({ projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.status, "in_progress"), isNull(tasks.stalledAt)));

      const verifying = await db
        .selectDistinct({ projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.status, "pending_verification"));

      const projectIds = Array.from(new Set([
        ...auto.map((r) => r.projectId),
        ...blocked.map((r) => r.projectId),
        ...inProgress.map((r) => r.projectId),
        ...verifying.map((r) => r.projectId),
      ]));

      await Promise.all(projectIds.map((id) => runCycle(db, id)));
    } catch (err) {
      console.error("[scheduler] tick error:", err);
    }
  }

  // Run immediately, then on interval
  tick();
  setInterval(tick, Math.min(TASK_POLL_MS, BLOCKED_POLL_MS));

  const model = process.env.ROUTING_MODEL ?? "claude-haiku-4-5-20251001";
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  console.log(
    `[scheduler] Started — poll=${TASK_POLL_MS}ms model=${model} claude=${hasKey ? "enabled" : "disabled (no API key)"}`
  );
}
