import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../../server.js";
import { detectStalls, watchProposedTasks } from "./scheduler.js";
import { bus, type AppEvent } from "../events.js";
import { createDb, tasks } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-stalls";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

let app: FastifyInstance;
let projectId: string;
let agentId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/projects", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ stalls" }),
  });
  projectId = project.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ projectId, name: "stall-agent", role: "worker" }),
  });
  agentId = a.json().data.id;
});

afterAll(async () => {
  if (projectId) {
    await app.inject({ method: "DELETE", url: `/projects/${projectId}`, headers: ADMIN });
  }
  await app?.close();
});

async function makeInProgressTask(updatedAtMsAgo: number): Promise<string> {
  const create = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({
      projectId, createdBy: agentId, title: "stall-test", description: "x",
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

    await detectStalls(db, projectId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.stalledAt).not.toBeNull();
  });

  it("does not flag a task that was updated recently", async () => {
    const taskId = await makeInProgressTask(0); // just created, updatedAt = now
    const db = createDb(DB_URL);

    await detectStalls(db, projectId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.stalledAt).toBeNull();
  });

  it("does not flag a task that's already been flagged (idempotent)", async () => {
    const taskId = await makeInProgressTask(5_000);
    const db = createDb(DB_URL);

    await detectStalls(db, projectId);
    const [first] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const initialStalledAt = first.stalledAt;
    expect(initialStalledAt).not.toBeNull();

    // Wait a tick, run again. stalledAt should not change because the WHERE
    // clause filters out rows with stalledAt set.
    await new Promise((r) => setTimeout(r, 20));
    await detectStalls(db, projectId);
    const [second] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(second.stalledAt!.getTime()).toBe(initialStalledAt!.getTime());
  });

  it("publishes a task.stalled event for each newly-flagged task", async () => {
    const taskId = await makeInProgressTask(5_000);
    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);

    const db = createDb(DB_URL);
    await detectStalls(db, projectId);

    bus.off("event", handler);
    const stalled = events.find((e) => e.kind === "task.stalled" && e.targetId === taskId);
    expect(stalled).toBeDefined();
    expect(stalled!.alsoNotify?.[0]?.targetId).toBe(agentId);
  });

  it("PUT /tasks/:id clears stalledAt when the task moves again", async () => {
    const taskId = await makeInProgressTask(5_000);
    const db = createDb(DB_URL);
    await detectStalls(db, projectId);

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
      body: JSON.stringify({ projectId, name: "overdue-orch", role: "orchestrator" }),
    });
    orchId = orch.json().data.id;

    const worker = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ projectId, name: "overdue-worker", role: "worker" }),
    });
    workerAuth = { Authorization: `Bearer ${worker.json().token}`, "Content-Type": "application/json" };
  });

  // A worker's create lands in "proposed"; back-date createdAt so it is overdue.
  async function makeOverdueProposal(createdMsAgo: number): Promise<string> {
    const create = await app.inject({
      method: "POST", url: "/tasks", headers: workerAuth,
      body: JSON.stringify({ projectId, createdBy: orchId, title: "proposal", description: "x" }),
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
    await watchProposedTasks(db, projectId);

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

    await watchProposedTasks(db, projectId);

    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);
    await watchProposedTasks(db, projectId);
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
    await watchProposedTasks(db, projectId);
    bus.off("event", handler);

    expect(events.some((e) => e.kind === "task.proposed_overdue" && e.targetId === taskId)).toBe(false);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect((row.metadata as Record<string, unknown>).proposedOverdueNotifiedAt).toBeUndefined();
  });
});
