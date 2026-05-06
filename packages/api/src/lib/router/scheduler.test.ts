import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../../server.js";
import { detectStalls } from "./scheduler.js";
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
