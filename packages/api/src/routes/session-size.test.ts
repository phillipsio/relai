import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-session-size";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

let app: FastifyInstance;
let repoId: string;
let agentId: string;
let auth: { Authorization: string };
let threadId: string;
let fatMetaMsgId: string;

const LONG = "x".repeat(6000);

const bundle = async () => {
  const res = await app.inject({ method: "GET", url: `/session/start?repoId=${repoId}`, headers: auth });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const p = await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name: "__test__ size" }) });
  repoId = p.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "size-agent", role: "worker" }),
  });
  agentId = a.json().data.id;
  auth = { Authorization: `Bearer ${a.json().token}` };

  const t = await app.inject({ method: "POST", url: "/threads", headers: ADMIN, body: JSON.stringify({ repoId, title: "noisy" }) });
  threadId = t.json().data.id;
  await app.inject({
    method: "POST", url: "/subscriptions", headers: ADMIN,
    body: JSON.stringify({ agentId, targetType: "thread", targetId: threadId }),
  });

  // A task carrying the two things that actually blow the payload up: a long
  // description and a large accumulated metadata blob.
  await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({
      repoId, createdBy: "human", title: "heavy task", description: LONG,
      assignedTo: agentId,
      metadata: { findings: Array.from({ length: 40 }, (_, i) => ({ i, note: "y".repeat(200) })) },
    }),
  });
  // …and a small one, which must survive untouched.
  await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({
      repoId, createdBy: "human", title: "light task", description: "short and complete",
      assignedTo: agentId, metadata: { branchName: "feat/x", roundNumber: 2 },
    }),
  });

  for (let i = 0; i < 45; i++) {
    await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: ADMIN,
      body: JSON.stringify({ fromAgent: "human", type: "finding", body: `msg ${i} ${LONG}` }),
    });
  }

  const fat = await app.inject({
    method: "POST", url: `/threads/${threadId}/messages`, headers: ADMIN,
    body: JSON.stringify({
      fromAgent: "human", type: "finding", body: "small body",
      metadata: { files: Array.from({ length: 30 }, (_, i) => `src/very/long/path/file-${i}.ts`) },
    }),
  });
  fatMetaMsgId = fat.json().data.id;
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

describe("the orientation call stays callable", () => {
  it("fits in a tool-output budget even with a noisy repo behind it", async () => {
    const size = JSON.stringify(await bundle()).length;
    expect(size).toBeLessThan(25_000);
  });
});

describe("unread messages are an index, not the archive", () => {
  it("caps how many come back and says how many there are", async () => {
    const d = await bundle();
    expect(d.unreadMessages.length).toBeLessThanOrEqual(20);
    expect(d.unreadCount).toBe(46);
    expect(d.unreadCount).toBeGreaterThan(d.unreadMessages.length);
  });

  // A cap with no ordering silently returns an arbitrary 20 of 45.
  it("returns the newest ones when it caps", async () => {
    const d = await bundle();
    const stamps = d.unreadMessages.map((m: { createdAt: string }) => Date.parse(m.createdAt));
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
    expect(d.unreadMessages[0].id).toBe(fatMetaMsgId);
    expect(d.unreadMessages.some((m: { body: string }) => m.body.startsWith("msg 0 "))).toBe(false);
  });

  it("collapses an oversized message metadata blob too", async () => {
    const d = await bundle();
    const m = d.unreadMessages.find((x: { id: string }) => x.id === fatMetaMsgId);
    expect(JSON.stringify(m.metadata).length).toBeLessThan(300);
    expect(m.metadata._truncated).toBe(true);
    expect(m.metadata.keys).toContain("files");
  });

  it("truncates a long body and marks it, so nothing reads as complete when it is not", async () => {
    const d = await bundle();
    const m = d.unreadMessages.find((x: { body: string }) => x.body.startsWith("msg 44"));
    expect(m).toBeDefined();
    expect(m.body.length).toBeLessThan(1000);
    expect(m.truncated).toBe(true);
    expect(m.bodyLength).toBeGreaterThan(6000);
  });
});

// Its own repo: a 30-task fixture in the shared one silently reshapes every
// later assertion, which is how this suite first went green for the wrong reason.
describe("every list in the bundle is bounded", () => {
  let bulkRepo: string;
  let bulkAuth: { Authorization: string };

  beforeAll(async () => {
    const p = await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name: "__test__ bulk" }) });
    bulkRepo = p.json().data.id;
    const a = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId: bulkRepo, name: "bulk-agent", role: "worker" }),
    });
    const bulkAgent = a.json().data.id;
    bulkAuth = { Authorization: `Bearer ${a.json().token}` };

    for (let i = 0; i < 30; i++) {
      await app.inject({
        method: "POST", url: "/tasks", headers: ADMIN,
        body: JSON.stringify({ repoId: bulkRepo, createdBy: "human", title: `bulk ${i}`, description: LONG, assignedTo: bulkAgent }),
      });
      const t = await app.inject({
        method: "POST", url: "/threads", headers: ADMIN,
        body: JSON.stringify({ repoId: bulkRepo, title: `bulk thread ${i}` }),
      });
      await app.inject({
        method: "POST", url: "/subscriptions", headers: ADMIN,
        body: JSON.stringify({ agentId: bulkAgent, targetType: "thread", targetId: t.json().data.id }),
      });
    }
  });

  afterAll(async () => {
    if (bulkRepo) await app.inject({ method: "DELETE", url: `/repos/${bulkRepo}`, headers: ADMIN });
  });

  const bulkBundle = async () => {
    const res = await app.inject({ method: "GET", url: `/session/start?repoId=${bulkRepo}`, headers: bulkAuth });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  };

  // The payload blew up because lists grew without limit. Capping only the one
  // that happened to be biggest leaves the same bug for the next busy repo.
  it("caps open tasks and reports the true total", async () => {
    const d = await bulkBundle();
    expect(d.tasks.length).toBeLessThanOrEqual(10);
    expect(d.taskCount).toBe(30);
  });

  it("caps subscribed open threads and reports the true total", async () => {
    const d = await bulkBundle();
    expect(d.openThreads.length).toBeLessThanOrEqual(25);
    expect(d.openThreadCount).toBe(30);
  });

  it("stays inside the budget with 30 of everything behind it", async () => {
    expect(JSON.stringify(await bulkBundle()).length).toBeLessThan(25_000);
  });
});

describe("tasks carry enough to choose, not enough to work", () => {
  it("truncates a long description and reports its real length", async () => {
    const d = await bundle();
    const heavy = d.tasks.find((t: { title: string }) => t.title === "heavy task");
    expect(heavy.description.length).toBeLessThan(600);
    expect(heavy.descriptionLength).toBe(LONG.length);
    expect(heavy.truncated).toBe(true);
  });

  it("collapses an oversized metadata blob to its keys", async () => {
    const d = await bundle();
    const heavy = d.tasks.find((t: { title: string }) => t.title === "heavy task");
    expect(JSON.stringify(heavy.metadata).length).toBeLessThan(500);
    expect(heavy.metadata._truncated).toBe(true);
    expect(heavy.metadata.keys).toContain("findings");
  });

  // Most tasks are small; passing them through unchanged keeps the common case
  // honest and avoids a follow-up call for nothing.
  it("leaves a small task completely alone", async () => {
    const d = await bundle();
    const light = d.tasks.find((t: { title: string }) => t.title === "light task");
    expect(light.description).toBe("short and complete");
    expect(light.truncated).toBeUndefined();
    expect(light.metadata.branchName).toBe("feat/x");
    expect(light.metadata.roundNumber).toBe(2);
    expect(light.metadata._truncated).toBeUndefined();
  });

  it("still says which tasks exist and how they stand", async () => {
    const d = await bundle();
    expect(d.tasks).toHaveLength(2);
    for (const t of d.tasks) {
      expect(t.id).toMatch(/^task_/);
      expect(t.status).toBeTruthy();
      expect(t.humanLabel).toBeTruthy();
    }
  });
});
