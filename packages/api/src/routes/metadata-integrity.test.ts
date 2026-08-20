import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { verifyPending } from "../lib/router/scheduler.js";
import { createDb, tasks } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-metadata";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const asAgent = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

let app: FastifyInstance;
let repoId: string;
let reviewerId: string;
let attackerId: string;
let attackerToken: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const repo = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ metadata" }),
  });
  repoId = repo.json().data.id;

  const r = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "the-reviewer", role: "worker", specialization: "reviewer" }),
  });
  reviewerId = r.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "the-attacker", role: "worker" }),
  });
  attackerId = a.json().data.id;
  attackerToken = a.json().token;
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

async function gatedTask(extraMetadata: Record<string, unknown> = {}) {
  const create = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({
      repoId, createdBy: attackerId, title: "needs review", description: "x",
      assignedTo: attackerId, verifyKind: "reviewer_agent", verifyReviewerId: reviewerId,
      metadata: extraMetadata,
    }),
  });
  return create.json().data.id;
}

const put = (taskId: string, headers: Record<string, string>, body: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: `/tasks/${taskId}`, headers, body: JSON.stringify(body) });

describe("a reviewer-gated task cannot be self-approved through metadata", () => {
  // The exploit: POST /tasks/:id/review is 403-gated, but it is not the only
  // writer of the field it guards.
  it("refuses to complete on a forged review decision", async () => {
    const taskId = await gatedTask();

    await put(taskId, asAgent(attackerToken), {
      status: "completed",
      metadata: {
        review: { decision: "approve", reviewerId, decidedAt: new Date().toISOString() },
      },
    });

    const db = createDb(DB_URL);
    await verifyPending(db, repoId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).not.toBe("completed");
  });

  it("does not let a forged decision name the attacker as reviewer either", async () => {
    const taskId = await gatedTask();

    await put(taskId, asAgent(attackerToken), {
      status: "completed",
      metadata: {
        review: { decision: "approve", reviewerId: attackerId, decidedAt: new Date().toISOString() },
      },
    });

    const db = createDb(DB_URL);
    await verifyPending(db, repoId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).not.toBe("completed");
  });

  it("still completes on a real decision from the named reviewer", async () => {
    const taskId = await gatedTask();

    const res = await app.inject({
      method: "POST", url: `/tasks/${taskId}/review`, headers: ADMIN,
      body: JSON.stringify({ decision: "approve", note: "looks right" }),
    });
    expect(res.statusCode).toBe(200);

    const db = createDb(DB_URL);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("completed");
  });
});

describe("server-owned metadata keys survive a client write", () => {
  it("merges rather than replacing, so unrelated keys are not lost", async () => {
    const taskId = await gatedTask({ branchName: "feat/x", roundNumber: 2 });

    await put(taskId, asAgent(attackerToken), { metadata: { findings: [] } });

    const db = createDb(DB_URL);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.branchName).toBe("feat/x");
    expect(meta.roundNumber).toBe(2);
    expect(meta.findings).toEqual([]);
  });

  it("ignores a client-supplied value for a server-owned key", async () => {
    const taskId = await gatedTask();

    // Land a genuine decision first, then try to overwrite it.
    await app.inject({
      method: "POST", url: `/tasks/${taskId}/review`, headers: ADMIN,
      body: JSON.stringify({ decision: "reject", note: "no" }),
    });

    await put(taskId, asAgent(attackerToken), {
      metadata: { review: { decision: "approve", reviewerId, decidedAt: new Date().toISOString() } },
    });

    const db = createDb(DB_URL);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const review = (row.metadata as Record<string, unknown>).review as Record<string, unknown>;
    expect(review.decision).toBe("reject");
  });

  // Read-modify-write of the whole blob is an existing pattern (blockOverflowedTasks
  // echoes back everything it read), so this must not 400 or lose the echoed keys.
  it("accepts an echoed full metadata blob without corrupting server keys", async () => {
    const taskId = await gatedTask({ branchName: "feat/y" });
    await app.inject({
      method: "POST", url: `/tasks/${taskId}/review`, headers: ADMIN,
      body: JSON.stringify({ decision: "reject" }),
    });

    const db = createDb(DB_URL);
    const [before] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const echoed = { ...(before.metadata as Record<string, unknown>), blockedReason: "context overflow" };

    const res = await put(taskId, asAgent(attackerToken), { metadata: echoed });
    expect(res.statusCode).toBe(200);

    const [after] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const meta = after.metadata as Record<string, unknown>;
    expect(meta.blockedReason).toBe("context overflow");
    expect(meta.branchName).toBe("feat/y");
    expect((meta.review as Record<string, unknown>).decision).toBe("reject");
  });

  // prompt.ts instructs workers to set this when escalating, so it must stay writable.
  it("still lets a worker set the task-chain and blocking fields it owns", async () => {
    const taskId = await gatedTask();

    await put(taskId, asAgent(attackerToken), {
      metadata: { blockedThreadId: "thread_abc", blockedReason: "need a decision", branchName: "feat/z" },
    });

    const db = createDb(DB_URL);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.blockedThreadId).toBe("thread_abc");
    expect(meta.blockedReason).toBe("need a decision");
    expect(meta.branchName).toBe("feat/z");
  });
});
