import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../../server.js";
import { detectStalls, watchProposedTasks, watchBlockedTasks } from "./scheduler.js";
import { bus, type AppEvent } from "../events.js";
import { createDb, tasks, subscriptions } from "@getrelai/db";
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
  const db = createDb(DB_URL);
  await db.update(tasks)
    .set({ updatedAt: new Date(Date.now() - updatedAtMsAgo) })
    .where(eq(tasks.id, taskId));

  return taskId;
}

describe("detectStalls", () => {
  it("flags an in_progress task whose updatedAt is older than the threshold", async () => {
    process.env.STALL_THRESHOLD_MS = "1000"; // 1s for the test (read lazily)
    const taskId = await makeInProgressTask(5_000);
    const db = createDb(DB_URL);

    await detectStalls(db, repoId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.stalledAt).not.toBeNull();
  });

  it("does not flag a task that was updated recently", async () => {
    const taskId = await makeInProgressTask(0); // just created, updatedAt = now
    const db = createDb(DB_URL);

    await detectStalls(db, repoId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.stalledAt).toBeNull();
  });

  it("does not flag a task that's already been flagged (idempotent)", async () => {
    const taskId = await makeInProgressTask(5_000);
    const db = createDb(DB_URL);

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

    const db = createDb(DB_URL);
    await detectStalls(db, repoId);

    bus.off("event", handler);
    const stalled = events.find((e) => e.kind === "task.stalled" && e.targetId === taskId);
    expect(stalled).toBeDefined();
    expect(stalled!.alsoNotify?.[0]?.targetId).toBe(agentId);
  });

  it("PUT /tasks/:id clears stalledAt when the task moves again", async () => {
    const taskId = await makeInProgressTask(5_000);
    const db = createDb(DB_URL);
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
    const db = createDb(DB_URL);
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

    const db = createDb(DB_URL);
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
    const db = createDb(DB_URL);

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
    const db = createDb(DB_URL);
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

    const db = createDb(DB_URL);
    await db.update(tasks)
      .set({ status: "blocked", metadata: { blockedThreadId: threadId } })
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

    const db = createDb(DB_URL);
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

    const db = createDb(DB_URL);
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
    const db = createDb(DB_URL);
    await db.update(tasks).set({ status: "blocked", metadata: {} }).where(eq(tasks.id, taskId));

    await watchBlockedTasks(db, repoId); // must not throw

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("blocked");
  });
});
