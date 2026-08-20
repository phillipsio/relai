import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildServer } from "../server.js";
import { watchBlockedTasks } from "../lib/router/scheduler.js";
import { bus, type AppEvent } from "../lib/events.js";
import { createDb, tasks, users } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-blocked-expiry";
const SERVICE_TOKEN = "test-service-blocked-expiry";
const ownerId = "usr_blocked_expiry_owner";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;
process.env.SERVICE_ADMIN_TOKEN = SERVICE_TOKEN;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const OWNER = { Authorization: `Bearer ${SERVICE_TOKEN}`, "X-Owner-Id": ownerId, "Content-Type": "application/json" };
const asAgent = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
let repoId: string;
let asker: string, askerToken: string;
let expert: string, expertToken: string;
let seen: AppEvent[] = [];

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const db = createDb(DB_URL);
  await db.insert(users).values({ id: ownerId, email: `${ownerId}@test.local` }).onConflictDoNothing();

  const repo = await app.inject({
    method: "POST", url: "/repos", headers: OWNER, body: JSON.stringify({ name: "__test__ blocked expiry" }),
  });
  repoId = repo.json().data.id;

  const mk = async (name: string) => {
    const a = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN, body: JSON.stringify({ repoId, name, role: "worker" }),
    });
    return { id: a.json().data.id as string, token: a.json().token as string };
  };
  ({ id: asker, token: askerToken } = await mk("expiry-asker"));
  ({ id: expert, token: expertToken } = await mk("expiry-expert"));

  bus.on("event", (e: AppEvent) => seen.push(e));
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

beforeEach(() => { seen = []; });

// Waiting is simulated by backdating blockedAt rather than by sleeping.
async function blockedFor(ms: number, opts: { toAgent?: string } = {}) {
  const th = await app.inject({
    method: "POST", url: "/threads", headers: ADMIN, body: JSON.stringify({ repoId, title: "waiting thread" }),
  });
  const threadId = th.json().data.id as string;

  const task = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({ repoId, createdBy: asker, title: "waiting", description: "x", assignedTo: asker }),
  });
  const taskId = task.json().data.id as string;

  await app.inject({
    method: "POST", url: `/threads/${threadId}/messages`, headers: asAgent(askerToken),
    body: JSON.stringify({ type: "question", body: "well?", ...(opts.toAgent ? { toAgent: opts.toAgent } : {}) }),
  });
  await app.inject({
    method: "PUT", url: `/tasks/${taskId}`, headers: asAgent(askerToken),
    body: JSON.stringify({ status: "blocked", metadata: { blockedThreadId: threadId } }),
  });

  const db = createDb(DB_URL);
  await db.update(tasks).set({ blockedAt: new Date(Date.now() - ms) }).where(eq(tasks.id, taskId));
  return { taskId, threadId };
}

const sweep = async () => watchBlockedTasks(createDb(DB_URL), repoId);
const load = async (taskId: string) => {
  const [row] = await createDb(DB_URL).select().from(tasks).where(eq(tasks.id, taskId));
  return row;
};
const overdueEvents = () => seen.filter((e) => e.kind === "task.blocked_overdue");

describe("a blocked task does not wait forever", () => {
  it("leaves a task alone while it is still within the window", async () => {
    const { taskId } = await blockedFor(60_000, { toAgent: expert });

    await sweep();

    const row = await load(taskId);
    expect(row.status).toBe("blocked");
    expect((row.metadata as Record<string, unknown>).blockedTimeout).toBeUndefined();
    expect(overdueEvents()).toHaveLength(0);
  });

  // Waiting on an agent: there is somewhere to fall back to, so hand the asker a
  // failure it can act on rather than leaving it stopped.
  it("releases a task that was waiting on an agent, with a result it can act on", async () => {
    const { taskId } = await blockedFor(60 * 60_000, { toAgent: expert });

    await sweep();

    const row = await load(taskId);
    expect(row.status).toBe("assigned");
    const timeout = (row.metadata as Record<string, unknown>).blockedTimeout as Record<string, unknown>;
    expect(timeout.awaitedAgent).toBe(expert);
    expect(typeof timeout.waitedMs).toBe("number");
    expect((row.metadata as Record<string, unknown>).agentReply).toBeUndefined();
    expect(overdueEvents()).toHaveLength(1);
  });

  // Waiting on a human: the human IS the fallback, so proceeding without them
  // defeats the point of blocking. Nudge instead.
  it("keeps a task waiting on a human blocked, and only nudges", async () => {
    const { taskId } = await blockedFor(60 * 60_000);

    await sweep();

    const row = await load(taskId);
    expect(row.status).toBe("blocked");
    expect((row.metadata as Record<string, unknown>).blockedTimeout).toBeUndefined();
    expect(overdueEvents()).toHaveLength(1);
  });

  it("nudges once, not on every tick", async () => {
    const { taskId } = await blockedFor(60 * 60_000);

    await sweep();
    seen = [];
    await sweep();

    expect(overdueEvents()).toHaveLength(0);
    expect((await load(taskId)).status).toBe("blocked");
  });

  it("prefers a real answer over a timeout when both are available", async () => {
    const { taskId, threadId } = await blockedFor(60 * 60_000, { toAgent: expert });
    await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: asAgent(expertToken),
      body: JSON.stringify({ type: "reply", body: "late but real" }),
    });

    await sweep();

    const meta = (await load(taskId)).metadata as Record<string, unknown>;
    expect((meta.agentReply as Record<string, unknown>).body).toBe("late but real");
    expect(meta.blockedTimeout).toBeUndefined();
    expect(overdueEvents()).toHaveLength(0);
  });

  it("counts the overdue kind as something the owner should hear about", async () => {
    const { OWNER_ATTENTION_KINDS } = await import("../lib/notifications.js");
    expect(OWNER_ATTENTION_KINDS.has("task.blocked_overdue")).toBe(true);
  });
});
