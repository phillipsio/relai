import Anthropic from "@anthropic-ai/sdk";
import { eq, and, inArray } from "drizzle-orm";
import { agents, tasks, routingLog, messages } from "@relai/db";
import type { Db } from "@relai/db";
import { newId } from "../id.js";
import { tryRulesRouting } from "./rules.js";
import { claudeRouting } from "./claude.js";

const TASK_POLL_MS    = Number(process.env.TASK_POLL_MS    ?? 15_000);
const BLOCKED_POLL_MS = Number(process.env.BLOCKED_POLL_MS ?? 15_000);

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

// ── Project-scoped cycle ──────────────────────────────────────────────────────

async function runCycle(db: Db, projectId: string): Promise<void> {
  await Promise.all([
    routePendingTasks(db, projectId).catch((err) =>
      console.error(`[scheduler] routing error project=${projectId}:`, err)
    ),
    watchBlockedTasks(db, projectId).catch((err) =>
      console.error(`[scheduler] blocked-watch error project=${projectId}:`, err)
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

      const projectIds = Array.from(new Set([
        ...auto.map((r) => r.projectId),
        ...blocked.map((r) => r.projectId),
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
