import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { watchBlockedTasks } from "../lib/router/scheduler.js";
import { createDb, tasks, users } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-resume";
const SERVICE_TOKEN = "test-service-resume";
const ownerId = "usr_resume_owner";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;
process.env.SERVICE_ADMIN_TOKEN = SERVICE_TOKEN;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const OWNER = {
  Authorization: `Bearer ${SERVICE_TOKEN}`,
  "X-Owner-Id": ownerId,
  "Content-Type": "application/json",
};

let app: FastifyInstance;
let repoId: string;
let agentId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const db = createDb(DB_URL);
  await db.insert(users).values({ id: ownerId, email: `${ownerId}@test.local` }).onConflictDoNothing();

  const repo = await app.inject({
    method: "POST", url: "/repos", headers: OWNER,
    body: JSON.stringify({ name: "__test__ resume" }),
  });
  repoId = repo.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "resume-worker", role: "worker" }),
  });
  agentId = a.json().data.id;
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

async function newThread(title: string) {
  const t = await app.inject({
    method: "POST", url: "/threads", headers: ADMIN, body: JSON.stringify({ repoId, title }),
  });
  return t.json().data.id;
}

async function newTask() {
  const c = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({ repoId, createdBy: agentId, title: "resume me", description: "x", assignedTo: agentId }),
  });
  return c.json().data.id;
}

const humanReply = (threadId: string, body: string) =>
  app.inject({
    method: "POST", url: `/threads/${threadId}/messages`, headers: OWNER,
    body: JSON.stringify({ type: "reply", body }),
  });

const block = (taskId: string, threadId: string) =>
  app.inject({
    method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
    body: JSON.stringify({ status: "blocked", metadata: { blockedThreadId: threadId } }),
  });

const statusOf = async (taskId: string) => {
  const db = createDb(DB_URL);
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return row;
};

describe("a blocked task resumes only on a reply that postdates the blocking", () => {
  // The bug: the watcher compared against task.createdAt, so any human message
  // already on the thread satisfied it the moment the task was blocked.
  it("ignores a human reply that predates the blocking", async () => {
    const threadId = await newThread("busy thread");
    const taskId = await newTask();

    await humanReply(threadId, "unrelated chatter from earlier");
    await block(taskId, threadId);

    const db = createDb(DB_URL);
    await watchBlockedTasks(db, repoId);

    const row = await statusOf(taskId);
    expect(row.status).toBe("blocked");
    expect((row.metadata as Record<string, unknown>).humanReply).toBeUndefined();
  });

  it("resumes on a reply that arrives after the blocking", async () => {
    const threadId = await newThread("answered thread");
    const taskId = await newTask();

    await block(taskId, threadId);
    await humanReply(threadId, "use the staging DB");

    const db = createDb(DB_URL);
    await watchBlockedTasks(db, repoId);

    const row = await statusOf(taskId);
    expect(row.status).toBe("assigned");
    expect((row.metadata as Record<string, unknown>).humanReply).toBe("use the staging DB");
  });

  it("stamps blockedAt on the transition into blocked", async () => {
    const threadId = await newThread("stamped thread");
    const taskId = await newTask();

    const before = await statusOf(taskId);
    expect(before.blockedAt).toBeNull();

    await block(taskId, threadId);

    const after = await statusOf(taskId);
    expect(after.blockedAt).not.toBeNull();
  });

  // Without re-stamping, the answer to the first question would immediately
  // resume the second blocking.
  it("re-stamps on a second blocking, so the first answer does not carry over", async () => {
    const threadId = await newThread("twice thread");
    const taskId = await newTask();

    await block(taskId, threadId);
    await humanReply(threadId, "first answer");
    const db = createDb(DB_URL);
    await watchBlockedTasks(db, repoId);
    expect((await statusOf(taskId)).status).toBe("assigned");

    await block(taskId, threadId);
    await watchBlockedTasks(db, repoId);

    expect((await statusOf(taskId)).status).toBe("blocked");
  });

  // Fails closed: a watchable row with no stamp is left alone rather than
  // resumed off whatever happens to be on the thread.
  it("skips a watchable row that has no blockedAt", async () => {
    const threadId = await newThread("unstamped thread");
    const taskId = await newTask();

    await humanReply(threadId, "an old answer");
    await block(taskId, threadId);

    const db = createDb(DB_URL);
    await db.update(tasks).set({ blockedAt: null }).where(eq(tasks.id, taskId));
    await watchBlockedTasks(db, repoId);

    expect((await statusOf(taskId)).status).toBe("blocked");
  });
});
