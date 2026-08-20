import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { ensureSubscription } from "../lib/events.js";
import { createDb, subscriptions } from "@getrelai/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-tenancy";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const asAgent = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
let repoA: string, repoB: string;
let agentA: string, tokenA: string;
let agentA2: string;
let agentB: string;
let taskB: string, threadB: string;
let taskA: string, threadA: string;

async function mkRepo(name: string) {
  const r = await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name }) });
  return r.json().data.id;
}
async function mkAgent(repoId: string, name: string) {
  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name, role: "worker" }),
  });
  return { id: a.json().data.id, token: a.json().token as string };
}
async function mkThread(repoId: string, title: string) {
  const t = await app.inject({ method: "POST", url: "/threads", headers: ADMIN, body: JSON.stringify({ repoId, title }) });
  return t.json().data.id;
}
async function mkTask(repoId: string, createdBy: string) {
  const c = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({ repoId, createdBy, title: "t", description: "x" }),
  });
  return c.json().data.id;
}

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  repoA = await mkRepo("__test__ tenancy A");
  repoB = await mkRepo("__test__ tenancy B");

  const a = await mkAgent(repoA, "tenancy-a");   agentA = a.id; tokenA = a.token;
  const a2 = await mkAgent(repoA, "tenancy-a2"); agentA2 = a2.id;
  const b = await mkAgent(repoB, "tenancy-b");   agentB = b.id;

  threadA = await mkThread(repoA, "thread in A");
  threadB = await mkThread(repoB, "thread in B");
  taskA = await mkTask(repoA, agentA);
  taskB = await mkTask(repoB, agentB);
});

afterAll(async () => {
  for (const r of [repoA, repoB]) {
    if (r) await app.inject({ method: "DELETE", url: `/repos/${r}`, headers: ADMIN });
  }
  await app?.close();
});

const subscribe = (headers: Record<string, string>, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/subscriptions", headers, body: JSON.stringify(body) });

describe("an agent cannot subscribe to another repo's entities", () => {
  // Without this, learning a foreign id is enough to receive every event on it,
  // and the SSE payload carries the whole task row.
  it("refuses a task in another repo", async () => {
    const res = await subscribe(asAgent(tokenA), { agentId: agentA, targetType: "task", targetId: taskB });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const db = createDb(DB_URL);
    const rows = await db.select().from(subscriptions)
      .where(and(eq(subscriptions.agentId, agentA), eq(subscriptions.targetId, taskB)));
    expect(rows).toEqual([]);
  });

  it("refuses a thread in another repo", async () => {
    const res = await subscribe(asAgent(tokenA), { agentId: agentA, targetType: "thread", targetId: threadB });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("refuses an agent in another repo", async () => {
    const res = await subscribe(asAgent(tokenA), { agentId: agentA, targetType: "agent", targetId: agentB });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  // 404 specifically, so an unresolvable target is diagnosable rather than
  // merely landing in the cross-repo branch with a misleading message.
  it("refuses a target that does not exist at all", async () => {
    const res = await subscribe(asAgent(tokenA), { agentId: agentA, targetType: "task", targetId: "task_nope" });
    expect(res.statusCode).toBe(404);
  });

  it("still allows subscribing within its own repo", async () => {
    // 200 on a repeat is the route's documented idempotency, not a failure.
    for (const [targetType, targetId] of [["task", taskA], ["thread", threadA], ["agent", agentA]] as const) {
      const res = await subscribe(asAgent(tokenA), { agentId: agentA, targetType, targetId });
      expect([200, 201]).toContain(res.statusCode);
    }
  });

  // The feedback route deliberately subscribes a reporter to a task in the
  // feedback repo. That is a server-chosen id, not a client-supplied one, so it
  // goes through the internal helper and stays allowed.
  it("leaves the internal cross-repo subscription helper working", async () => {
    const db = createDb(DB_URL);
    await ensureSubscription(db, agentA, "task", taskB);

    const rows = await db.select().from(subscriptions)
      .where(and(eq(subscriptions.agentId, agentA), eq(subscriptions.targetId, taskB)));
    expect(rows).toHaveLength(1);
  });
});

describe("an agent cannot act on another agent's inbox", () => {
  it("refuses to mark a thread read on behalf of a different agent", async () => {
    const res = await app.inject({
      method: "PUT", url: `/threads/${threadA}/messages/read`, headers: asAgent(tokenA),
      body: JSON.stringify({ agentId: agentA2 }),
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses to read a different agent's unread feed", async () => {
    const res = await app.inject({
      method: "GET", url: `/messages/unread?agentId=${agentA2}&repoId=${repoA}`, headers: asAgent(tokenA),
    });

    expect(res.statusCode).toBe(403);
  });

  it("still allows an agent to act on its own inbox", async () => {
    const read = await app.inject({
      method: "PUT", url: `/threads/${threadA}/messages/read`, headers: asAgent(tokenA),
      body: JSON.stringify({ agentId: agentA }),
    });
    expect(read.statusCode).toBe(200);

    const unread = await app.inject({
      method: "GET", url: `/messages/unread?agentId=${agentA}&repoId=${repoA}`, headers: asAgent(tokenA),
    });
    expect(unread.statusCode).toBe(200);
  });

  // The CLI and dashboard pass an explicit agentId over the admin path.
  it("still allows the admin path to name any agent", async () => {
    const read = await app.inject({
      method: "PUT", url: `/threads/${threadA}/messages/read`, headers: ADMIN,
      body: JSON.stringify({ agentId: agentA2 }),
    });
    expect(read.statusCode).toBe(200);

    const unread = await app.inject({
      method: "GET", url: `/messages/unread?agentId=${agentA2}&repoId=${repoA}`, headers: ADMIN,
    });
    expect(unread.statusCode).toBe(200);
  });
});
