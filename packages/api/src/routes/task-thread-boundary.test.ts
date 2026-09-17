// A task's comment thread is the one the server linked to it. Nothing else may
// become one: not a thread in another project, and not a DM, whose whole point is
// that only its two participants can read it. The task-level access check cannot
// catch either, because the task really is in the caller's own project.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import { createDb, users, repos, tasks } from "@getrelai/db";
import { bus, type AppEvent } from "../lib/events.js";
import { eq } from "drizzle-orm";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-thread-boundary";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

const OWNER = "usr_thread_boundary_owner";

let app: FastifyInstance;
const db = createDb(DB_URL);

let repoA: string, repoB: string;
let alice: string, aliceTok: string;
let bob: string, bobTok: string;
let carol: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
  await db.insert(users).values({ id: OWNER, email: `${OWNER}@example.com` }).onConflictDoNothing();

  const mkRepo = async (name: string) => {
    const r = await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name }) });
    const id = r.json().data.id as string;
    await db.update(repos).set({ ownerId: OWNER }).where(eq(repos.id, id));
    return id;
  };
  repoA = await mkRepo("__test__ boundary A");
  repoB = await mkRepo("__test__ boundary B");

  const mkAgent = async (repoId: string, name: string) => {
    const a = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name, role: "orchestrator" }),
    });
    return { id: a.json().data.id as string, token: a.json().token as string };
  };
  ({ id: alice, token: aliceTok } = await mkAgent(repoA, "boundary-alice"));
  ({ id: bob, token: bobTok } = await mkAgent(repoA, "boundary-bob"));
  ({ id: carol } = await mkAgent(repoB, "boundary-carol"));
});

afterAll(async () => {
  for (const r of [repoA, repoB]) {
    if (r) await app.inject({ method: "DELETE", url: `/repos/${r}`, headers: ADMIN });
  }
  await db.delete(users).where(eq(users.id, OWNER));
  await app?.close();
});

async function mkTask(repoId: string, createdBy: string, auth: Record<string, string>) {
  const r = await app.inject({
    method: "POST", url: "/tasks", headers: auth,
    body: JSON.stringify({ repoId, createdBy, title: "t", description: "d" }),
  });
  expect(r.statusCode).toBe(201);
  return r.json().data.id as string;
}

// A thread in the OTHER project, carrying text the caller must never see.
async function foreignThread(secret: string) {
  const t = await app.inject({
    method: "POST", url: "/threads", headers: ADMIN,
    body: JSON.stringify({ repoId: repoB, title: "other project planning" }),
  });
  const threadId = t.json().data.id as string;
  await app.inject({
    method: "POST", url: `/threads/${threadId}/messages`, headers: ADMIN,
    body: JSON.stringify({ fromAgent: carol, body: secret, type: "status" }),
  });
  return threadId;
}

// A DM between two agents in the caller's OWN project: same repo, still private.
async function dmThread(secret: string) {
  const r = await app.inject({
    method: "POST", url: `/agents/${bob}/messages`, headers: as(aliceTok),
    body: JSON.stringify({ body: secret, type: "question" }),
  });
  expect(r.statusCode).toBe(201);
  return r.json().data.threadId as string;
}

describe("PUT /tasks/:id cannot re-point a task's comment thread", () => {
  it("a threadId in the body does not reach the column", async () => {
    const taskId = await mkTask(repoA, alice, as(aliceTok));
    const foreign = await foreignThread("CONFIDENTIAL OTHER-PROJECT TEXT");

    const res = await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: as(aliceTok),
      body: JSON.stringify({ threadId: foreign }),
    });
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.threadId).toBeNull();
  });

  it("and the comments route therefore never serves the other project's text", async () => {
    const taskId = await mkTask(repoA, alice, as(aliceTok));
    const foreign = await foreignThread("CONFIDENTIAL OTHER-PROJECT TEXT");
    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: as(aliceTok),
      body: JSON.stringify({ threadId: foreign }),
    });

    const res = await app.inject({ method: "GET", url: `/tasks/${taskId}/comments`, headers: as(aliceTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.threadId).not.toBe(foreign);
    expect(JSON.stringify(res.json())).not.toContain("CONFIDENTIAL OTHER-PROJECT TEXT");
  });

  it("other fields in the same request still apply", async () => {
    const taskId = await mkTask(repoA, alice, as(aliceTok));
    const foreign = await foreignThread("CONFIDENTIAL OTHER-PROJECT TEXT");
    const res = await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: as(aliceTok),
      body: JSON.stringify({ threadId: foreign, title: "renamed" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.title).toBe("renamed");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.threadId).toBeNull();
  });
});

// The column is unconstrained, so a row poisoned before this fix landed (or by any
// future writer) must not be served either. The check has to live where the thread
// is read, not only where it is written.
describe("a task pointing at a thread it should not own is not served", () => {
  it("a cross-project pointer is ignored and a fresh thread is linked", async () => {
    const taskId = await mkTask(repoA, alice, as(aliceTok));
    const foreign = await foreignThread("CONFIDENTIAL OTHER-PROJECT TEXT");
    await db.update(tasks).set({ threadId: foreign }).where(eq(tasks.id, taskId));

    const res = await app.inject({ method: "GET", url: `/tasks/${taskId}/comments`, headers: as(aliceTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.threadId).not.toBe(foreign);
    expect(res.json().data.comments).toEqual([]);
    expect(JSON.stringify(res.json())).not.toContain("CONFIDENTIAL OTHER-PROJECT TEXT");
  });

  it("a DM pointer is ignored even though the DM is in the same project", async () => {
    const taskId = await mkTask(repoA, alice, as(aliceTok));
    const dm = await dmThread("PRIVATE DM TEXT");
    await db.update(tasks).set({ threadId: dm }).where(eq(tasks.id, taskId));

    const res = await app.inject({ method: "GET", url: `/tasks/${taskId}/comments`, headers: as(aliceTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.threadId).not.toBe(dm);
    expect(JSON.stringify(res.json())).not.toContain("PRIVATE DM TEXT");
  });

  it("a comment posted against a poisoned pointer does not land in the DM", async () => {
    const taskId = await mkTask(repoA, alice, as(aliceTok));
    const dm = await dmThread("PRIVATE DM TEXT");
    await db.update(tasks).set({ threadId: dm }).where(eq(tasks.id, taskId));

    const post = await app.inject({
      method: "POST", url: `/tasks/${taskId}/comments`, headers: as(aliceTok),
      body: JSON.stringify({ body: "a comment that must not reach the DM" }),
    });
    expect(post.statusCode).toBe(201);

    const inDm = await app.inject({ method: "GET", url: `/threads/${dm}/messages`, headers: as(bobTok) });
    expect(JSON.stringify(inDm.json())).not.toContain("a comment that must not reach the DM");
  });

  // Relinking overwrites the only pointer recording which thread was exposed, and
  // for a DM that pointer is usually evidence: until this check existed, the read
  // path served that conversation to whoever asked.
  it("records what the pointer was before overwriting it", async () => {
    const taskId = await mkTask(repoA, alice, as(aliceTok));
    const dm = await dmThread("PRIVATE DM TEXT");
    await db.update(tasks).set({ threadId: dm }).where(eq(tasks.id, taskId));

    await app.inject({ method: "GET", url: `/tasks/${taskId}/comments`, headers: as(aliceTok) });

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const relinked = (row.metadata as Record<string, any>).threadRelinked;
    expect(relinked).toBeDefined();
    expect(relinked.from).toBe(dm);
    expect(relinked.wasDm).toBe(true);
    expect(relinked.at).toEqual(expect.any(String));
  });

  it("raises an event so the relink reaches a person, not just a log line", async () => {
    const taskId = await mkTask(repoA, alice, as(aliceTok));
    const foreign = await foreignThread("CONFIDENTIAL OTHER-PROJECT TEXT");
    await db.update(tasks).set({ threadId: foreign }).where(eq(tasks.id, taskId));

    const seen: AppEvent[] = [];
    const handler = (e: AppEvent) => seen.push(e);
    bus.on("event", handler);
    await app.inject({ method: "GET", url: `/tasks/${taskId}/comments`, headers: as(aliceTok) });
    bus.off("event", handler);

    const evt = seen.find((e) => e.kind === "task.thread_relinked" && e.targetId === taskId);
    expect(evt).toBeDefined();
    expect((evt!.payload as Record<string, unknown>).relinkedFrom).toBe(foreign);
    expect((evt!.payload as Record<string, unknown>).wasDm).toBe(false);
  });

  it("a client cannot forge or erase the relink record through metadata", async () => {
    const taskId = await mkTask(repoA, alice, as(aliceTok));
    const dm = await dmThread("PRIVATE DM TEXT");
    await db.update(tasks).set({ threadId: dm }).where(eq(tasks.id, taskId));
    await app.inject({ method: "GET", url: `/tasks/${taskId}/comments`, headers: as(aliceTok) });

    const res = await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: as(aliceTok),
      body: JSON.stringify({ metadata: { threadRelinked: { from: "thread_innocent", wasDm: false } } }),
    });
    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect((row.metadata as Record<string, any>).threadRelinked.from).toBe(dm);
  });

  it("an ordinary first-time link records nothing, since nothing was overwritten", async () => {
    const taskId = await mkTask(repoA, alice, as(aliceTok));
    await app.inject({ method: "GET", url: `/tasks/${taskId}/comments`, headers: as(aliceTok) });
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect((row.metadata as Record<string, unknown>).threadRelinked).toBeUndefined();
  });

  it("the legitimate linked thread is still reused across calls", async () => {
    const taskId = await mkTask(repoA, alice, as(aliceTok));
    const first = await app.inject({ method: "GET", url: `/tasks/${taskId}/comments`, headers: as(aliceTok) });
    const second = await app.inject({ method: "GET", url: `/tasks/${taskId}/comments`, headers: as(aliceTok) });
    expect(first.json().data.threadId).toBe(second.json().data.threadId);

    await app.inject({
      method: "POST", url: `/tasks/${taskId}/comments`, headers: as(aliceTok),
      body: JSON.stringify({ body: "a real comment" }),
    });
    const third = await app.inject({ method: "GET", url: `/tasks/${taskId}/comments`, headers: as(aliceTok) });
    expect(third.json().data.threadId).toBe(first.json().data.threadId);
    expect(JSON.stringify(third.json())).toContain("a real comment");
  });
});
