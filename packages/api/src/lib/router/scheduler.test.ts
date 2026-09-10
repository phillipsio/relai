import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildServer } from "../../server.js";
import { detectStalls, watchProposedTasks, watchBlockedTasks, reapStalledTasks, routePendingTasks } from "./scheduler.js";
import { bus, type AppEvent } from "../events.js";
import { createDb, tasks, subscriptions, agents } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-stalls";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

let app: FastifyInstance;
let repoId: string;
let agentId: string;

// One pool for the file: createDb opens 10 connections, and a call per helper
// exhausted Postgres's 100 and broke *other* suites, far from the cause.
const db = createDb(DB_URL);

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ stalls" }),
  });
  repoId = project.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "stall-agent", role: "worker" }),
  });
  agentId = a.json().data.id;
});

afterAll(async () => {
  if (repoId) {
    await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  }
  await app?.close();
});

async function makeInProgressTask(updatedAtMsAgo: number): Promise<string> {
  const create = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({
      repoId, createdBy: agentId, title: "stall-test", description: "x",
      assignedTo: agentId, status: "in_progress",
    }),
  });
  const taskId = create.json().data.id;

  // Back-date updatedAt so the task qualifies as stalled.
  await db.update(tasks)
    .set({ updatedAt: new Date(Date.now() - updatedAtMsAgo) })
    .where(eq(tasks.id, taskId));

  return taskId;
}

describe("detectStalls", () => {
  it("flags an in_progress task whose updatedAt is older than the threshold", async () => {
    process.env.STALL_THRESHOLD_MS = "1000"; // 1s for the test (read lazily)
    const taskId = await makeInProgressTask(5_000);

    await detectStalls(db, repoId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.stalledAt).not.toBeNull();
  });

  it("does not flag a task that was updated recently", async () => {
    const taskId = await makeInProgressTask(0); // just created, updatedAt = now

    await detectStalls(db, repoId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.stalledAt).toBeNull();
  });

  it("does not flag a task that's already been flagged (idempotent)", async () => {
    const taskId = await makeInProgressTask(5_000);

    await detectStalls(db, repoId);
    const [first] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const initialStalledAt = first.stalledAt;
    expect(initialStalledAt).not.toBeNull();

    // Wait a tick, run again. stalledAt should not change because the WHERE
    // clause filters out rows with stalledAt set.
    await new Promise((r) => setTimeout(r, 20));
    await detectStalls(db, repoId);
    const [second] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(second.stalledAt!.getTime()).toBe(initialStalledAt!.getTime());
  });

  it("publishes a task.stalled event for each newly-flagged task", async () => {
    const taskId = await makeInProgressTask(5_000);
    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);
    await detectStalls(db, repoId);

    bus.off("event", handler);
    const stalled = events.find((e) => e.kind === "task.stalled" && e.targetId === taskId);
    expect(stalled).toBeDefined();
    expect(stalled!.alsoNotify?.[0]?.targetId).toBe(agentId);
  });

  it("PUT /tasks/:id clears stalledAt when the task moves again", async () => {
    const taskId = await makeInProgressTask(5_000);
    await detectStalls(db, repoId);

    const [before] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(before.stalledAt).not.toBeNull();

    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
      body: JSON.stringify({ status: "completed" }),
    });

    const [after] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(after.stalledAt).toBeNull();
  });
});

describe("watchProposedTasks", () => {
  let orchId: string;
  let workerAuth: { Authorization: string; "Content-Type": string };

  beforeAll(async () => {
    const orch = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "overdue-orch", role: "orchestrator" }),
    });
    orchId = orch.json().data.id;

    const worker = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "overdue-worker", role: "worker" }),
    });
    workerAuth = { Authorization: `Bearer ${worker.json().token}`, "Content-Type": "application/json" };
  });

  // A worker's create lands in "proposed"; back-date createdAt so it is overdue.
  async function makeOverdueProposal(createdMsAgo: number): Promise<string> {
    const create = await app.inject({
      method: "POST", url: "/tasks", headers: workerAuth,
      body: JSON.stringify({ repoId, createdBy: orchId, title: "proposal", description: "x" }),
    });
    const taskId = create.json().data.id;
    expect(create.json().data.status).toBe("proposed");
    await db.update(tasks)
      .set({ createdAt: new Date(Date.now() - createdMsAgo) })
      .where(eq(tasks.id, taskId));
    return taskId;
  }

  it("emits a one-time task.proposed_overdue and notifies orchestrators", async () => {
    process.env.PROPOSED_OVERDUE_MS = "1000"; // 1s threshold for the test
    const taskId = await makeOverdueProposal(5_000);

    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);
    await watchProposedTasks(db, repoId);

    bus.off("event", handler);
    const evt = events.find((e) => e.kind === "task.proposed_overdue" && e.targetId === taskId);
    expect(evt).toBeDefined();
    expect(evt!.alsoNotify?.some((n) => n.targetId === orchId)).toBe(true);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect((row.metadata as Record<string, unknown>).proposedOverdueNotifiedAt).toBeDefined();
  });

  it("does not re-notify an already-notified proposal (idempotent)", async () => {
    process.env.PROPOSED_OVERDUE_MS = "1000";
    const taskId = await makeOverdueProposal(5_000);

    await watchProposedTasks(db, repoId);

    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);
    await watchProposedTasks(db, repoId);
    bus.off("event", handler);

    expect(events.some((e) => e.kind === "task.proposed_overdue" && e.targetId === taskId)).toBe(false);
  });

  it("does not flag a proposal that is younger than the threshold", async () => {
    process.env.PROPOSED_OVERDUE_MS = "600000"; // 10min — fresh proposal is not overdue
    const taskId = await makeOverdueProposal(0);

    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);
    await watchProposedTasks(db, repoId);
    bus.off("event", handler);

    expect(events.some((e) => e.kind === "task.proposed_overdue" && e.targetId === taskId)).toBe(false);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect((row.metadata as Record<string, unknown>).proposedOverdueNotifiedAt).toBeUndefined();
  });
});

describe("watchBlockedTasks (operator unblock path)", () => {
  // The headline behavior of the operator ingress: a human reply on a blocked
  // task's thread resumes the worker. This exercises the full path end-to-end.
  async function makeBlockedTaskOnThread(): Promise<{ taskId: string; threadId: string }> {
    const thread = await app.inject({
      method: "POST", url: "/threads", headers: ADMIN,
      body: JSON.stringify({ repoId, title: "blocked-on-question" }),
    });
    const threadId = thread.json().data.id;

    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: agentId, title: "needs-input", description: "x",
        assignedTo: agentId, status: "in_progress",
      }),
    });
    const taskId = create.json().data.id;
    // Backdated: the resume compares the reply's Postgres createdAt against
    // this with a strict >, so a same-millisecond block flakes under load.
    await db.update(tasks)
      .set({
        status: "blocked",
        blockedAt: new Date(Date.now() - 60_000),
        metadata: { blockedThreadId: threadId },
      })
      .where(eq(tasks.id, taskId));
    return { taskId, threadId };
  }

  it("resumes a blocked task to 'assigned' and records the human reply", async () => {
    const { taskId, threadId } = await makeBlockedTaskOnThread();

    // A human reply on the blocking thread is the resume trigger. (Posted via
    // the admin path, which passes fromAgent through — the owner MCP path
    // stamps "human" server-side; that's covered in ownership.test.ts.)
    const post = await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: ADMIN,
      body: JSON.stringify({ fromAgent: "human", type: "reply", body: "use the staging DB" }),
    });
    expect(post.statusCode).toBe(201);
    await watchBlockedTasks(db, repoId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("assigned");
    expect((row.metadata as Record<string, unknown>).humanReply).toBe("use the staging DB");

    // The "human" sender has no agent row — the message route must skip the
    // subscription insert (subscriptions.agentId is an FK) rather than 500.
    const humanSubs = await db.select().from(subscriptions).where(eq(subscriptions.agentId, "human"));
    expect(humanSubs).toEqual([]);
  });

  it("leaves a blocked task untouched when only the worker has posted (no human reply)", async () => {
    const { taskId, threadId } = await makeBlockedTaskOnThread();

    await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: ADMIN,
      body: JSON.stringify({ fromAgent: agentId, type: "status", body: "still stuck" }),
    });
    await watchBlockedTasks(db, repoId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("blocked");
  });

  it("ignores a blocked task with no blockedThreadId (malformed/unwatchable row)", async () => {
    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: agentId, title: "blocked-no-thread", description: "x",
        assignedTo: agentId, status: "in_progress",
      }),
    });
    const taskId = create.json().data.id;
    await db.update(tasks).set({ status: "blocked", metadata: {} }).where(eq(tasks.id, taskId));

    await watchBlockedTasks(db, repoId); // must not throw

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("blocked");
  });
});

describe("reapStalledTasks", () => {
  async function makeStalled(opts: { stalledMsAgo: number; releases?: number }): Promise<string> {
    const taskId = await makeInProgressTask(60_000);
    const meta: Record<string, unknown> = {};
    if (opts.releases !== undefined) meta.stallReleaseCount = opts.releases;
    await db.update(tasks)
      .set({ stalledAt: new Date(Date.now() - opts.stalledMsAgo), metadata: meta })
      .where(eq(tasks.id, taskId));
    return taskId;
  }

  const row = async (id: string) => {
    const [t] = await db.select().from(tasks).where(eq(tasks.id, id));
    return t;
  };

  // `assigned` would stay counted by load balancing and, since stall detection
  // only scans in_progress, become permanently undetectable.
  it("re-queues a reapable stalled task as pending/@auto and clears the dead assignee", async () => {
    const id = await makeStalled({ stalledMsAgo: 7_200_000 });
    await reapStalledTasks(db, repoId);

    const t = await row(id);
    expect(t.status).toBe("pending");
    expect(t.autoAssign).toBe(true);
    expect(t.assignedTo).toBeNull();
    expect(t.stalledAt).toBeNull();

    const meta = t.metadata as Record<string, any>;
    expect(meta.stallReleaseCount).toBe(1);
    expect(meta.stallRelease.previousAssignee).toBe(agentId);
  });

  it("leaves a stalled task alone until the reap bound has elapsed", async () => {
    const id = await makeStalled({ stalledMsAgo: 1_000 });
    await reapStalledTasks(db, repoId);

    const t = await row(id);
    expect(t.status).toBe("in_progress");
    expect(t.stalledAt).not.toBeNull();
  });

  it("does not touch an in_progress task that was never flagged as stalled", async () => {
    const id = await makeInProgressTask(60_000);
    await reapStalledTasks(db, repoId);
    expect((await row(id)).status).toBe("in_progress");
  });

  // Unbounded, this is an infinite retry: re-queue, stall, re-queue.
  it("blocks instead of re-queueing once the release bound is exhausted", async () => {
    const id = await makeStalled({ stalledMsAgo: 7_200_000, releases: 2 });
    await reapStalledTasks(db, repoId);

    const t = await row(id);
    expect(t.status).toBe("blocked");
    expect(t.blockedAt).not.toBeNull();
    const meta = t.metadata as Record<string, any>;
    expect(meta.blockedReason).toMatch(/stall/i);
    // No blockedThreadId: nothing is being awaited, so the resume watcher must
    // not revive it. Same reasoning as the overflow handler.
    expect(meta.blockedThreadId).toBeUndefined();
  });

  it("emits task.stall_released once per release, and task.stall_exhausted on the bound", async () => {
    const seen: AppEvent[] = [];
    const handler = (e: AppEvent) => seen.push(e);
    await makeStalled({ stalledMsAgo: 7_200_000 });
    await makeStalled({ stalledMsAgo: 7_200_000, releases: 2 });
    bus.on("event", handler);
    try { await reapStalledTasks(db, repoId); } finally { bus.off("event", handler); }

    expect(seen.filter((e) => e.kind === "task.stall_released")).toHaveLength(1);
    expect(seen.filter((e) => e.kind === "task.stall_exhausted")).toHaveLength(1);
  });

  it("is idempotent: a second pass re-queues nothing", async () => {
    await makeStalled({ stalledMsAgo: 7_200_000 });
    await reapStalledTasks(db, repoId);

    const seen: AppEvent[] = [];
    const handler = (e: AppEvent) => seen.push(e);
    bus.on("event", handler);
    try { await reapStalledTasks(db, repoId); } finally { bus.off("event", handler); }
    expect(seen.filter((e) => e.kind.startsWith("task.stall_"))).toHaveLength(0);
  });
});

describe("routePendingTasks: an unchanging skip condition", () => {
  it("resets when reapStalledTasks re-queues the task, so a second stall is reported", async () => {
    const repo = await app.inject({
      method: "POST", url: "/repos", headers: ADMIN,
      body: JSON.stringify({ name: "__test__ route-log-reap" }),
    });
    const rRepoId = repo.json().data.id;
    const w = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId: rRepoId, name: "reap-worker", role: "worker" }),
    });
    const reapWorkerId = w.json().data.id;

    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId: rRepoId, createdBy: reapWorkerId, title: "unroutable-reap", description: "x",
        assignedTo: "@auto", specialization: "nobody-has-this",
      }),
    });
    const taskId = create.json().data.id;

    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => { logs.push(String(m)); });
    try {
      const db = createDb(DB_URL);
      await routePendingTasks(db, rRepoId);
      expect(logs.filter((l) => l.includes("needs Claude routing"))).toHaveLength(1);

      // Simulate the row having gone in_progress and stalled, then reaped.
      await db.update(tasks)
        .set({ status: "in_progress", assignedTo: reapWorkerId, stalledAt: new Date(Date.now() - 999_999_999) })
        .where(eq(tasks.id, taskId));
      await reapStalledTasks(db, rRepoId);

      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row.status).toBe("pending");
      expect(row.autoAssign).toBe(true);

      await routePendingTasks(db, rRepoId);
      expect(logs.filter((l) => l.includes("needs Claude routing"))).toHaveLength(2);
    } finally {
      spy.mockRestore();
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it("resets when a task is manually assigned via PUT, so a later stall is reported again", async () => {
    const repo = await app.inject({
      method: "POST", url: "/repos", headers: ADMIN,
      body: JSON.stringify({ name: "__test__ route-log-manual" }),
    });
    const rRepoId = repo.json().data.id;
    const w = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId: rRepoId, name: "manual-worker", role: "worker" }),
    });
    const manualWorkerId = w.json().data.id;

    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId: rRepoId, createdBy: manualWorkerId, title: "unroutable-manual", description: "x",
        assignedTo: "@auto", specialization: "nobody-has-this",
      }),
    });
    const taskId = create.json().data.id;

    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => { logs.push(String(m)); });
    try {
      const db = createDb(DB_URL);
      await routePendingTasks(db, rRepoId);
      expect(logs.filter((l) => l.includes("needs Claude routing"))).toHaveLength(1);

      const assign = await app.inject({
        method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
        body: JSON.stringify({ assignedTo: manualWorkerId, status: "assigned" }),
      });
      expect(assign.statusCode).toBe(200);

      await app.inject({
        method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
        body: JSON.stringify({ status: "pending", assignedTo: null }),
      });
      await db.update(tasks).set({ autoAssign: true }).where(eq(tasks.id, taskId));

      await routePendingTasks(db, rRepoId);
      expect(logs.filter((l) => l.includes("needs Claude routing"))).toHaveLength(2);
    } finally {
      spy.mockRestore();
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });


  it("logs the missing-key skip once per task, not once per tick", async () => {
    const repo = await app.inject({
      method: "POST", url: "/repos", headers: ADMIN,
      body: JSON.stringify({ name: "__test__ route-log-once" }),
    });
    const rRepoId = repo.json().data.id;

    // A worker must exist or routePendingTasks returns before the branch;
    // its specialization must not match, so rules cannot resolve the task.
    const w = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId: rRepoId, name: "w-writer", role: "worker", specialization: "writer" }),
    });
    const wId = w.json().data.id;

    await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId: rRepoId, createdBy: wId, title: "unroutable", description: "x",
        assignedTo: "@auto", specialization: "nobody-has-this",
      }),
    });

    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => { logs.push(String(m)); });
    try {
      const db = createDb(DB_URL);
      await routePendingTasks(db, rRepoId);
      await routePendingTasks(db, rRepoId);
      await routePendingTasks(db, rRepoId);

      const skips = logs.filter((l) => l.includes("needs Claude routing"));
      expect(skips).toHaveLength(1);

      // A stalled task is re-queued as pending+autoAssign by reapStalledTasks,
      // so the same row can come back around and must be reported again.
      const [row] = await db.select().from(tasks).where(eq(tasks.repoId, rRepoId));
      await db.update(tasks)
        .set({ specialization: null, status: "pending", assignedTo: null, autoAssign: true })
        .where(eq(tasks.id, row.id));
      // Rules pre-filter to agents seen in the last 10 minutes, and a freshly
      // registered agent starts at the epoch.
      await app.inject({ method: "PUT", url: `/agents/${wId}/heartbeat`, headers: ADMIN });
      await routePendingTasks(db, rRepoId);          // rules now match -> routed, resets
      // Rules fall back to ALL online agents when no specialization matches, so
      // the only way back to unroutable is for the worker to go offline again.
      await db.update(agents).set({ lastSeenAt: new Date(0) }).where(eq(agents.id, wId));
      await db.update(tasks)
        .set({ specialization: "nobody-has-this", status: "pending", assignedTo: null, autoAssign: true })
        .where(eq(tasks.id, row.id));
      await routePendingTasks(db, rRepoId);          // unroutable again -> reported again

      expect(logs.filter((l) => l.includes("needs Claude routing"))).toHaveLength(2);
    } finally {
      spy.mockRestore();
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
});
