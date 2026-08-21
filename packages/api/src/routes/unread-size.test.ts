import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-unread-size";
process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const LONG = "y".repeat(5000);

let app: FastifyInstance;
let repoId: string, agentId: string, threadId: string;
let auth: { Authorization: string };

const unread = async () => {
  const res = await app.inject({
    method: "GET", url: `/messages/unread?agentId=${agentId}&repoId=${repoId}`, headers: auth,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
};

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const p = await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name: "__test__ unread" }) });
  repoId = p.json().data.id;
  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN, body: JSON.stringify({ repoId, name: "unread-agent", role: "worker" }),
  });
  agentId = a.json().data.id;
  auth = { Authorization: `Bearer ${a.json().token}` };

  const t = await app.inject({ method: "POST", url: "/threads", headers: ADMIN, body: JSON.stringify({ repoId, title: "loud" }) });
  threadId = t.json().data.id;

  for (let i = 0; i < 35; i++) {
    await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: ADMIN,
      body: JSON.stringify({ fromAgent: "human", type: "finding", body: `note ${i} ${LONG}`, metadata: { files: Array.from({ length: 30 }, (_, n) => `src/some/long/path/file-${n}.ts`) } }),
    });
  }
  await app.inject({
    method: "POST", url: `/threads/${threadId}/messages`, headers: ADMIN,
    body: JSON.stringify({ fromAgent: "human", type: "question", body: "short and whole" }),
  });
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

describe("the unread feed is bounded", () => {
  it("fits a tool-output budget where it used to be ~96KB", async () => {
    expect(JSON.stringify(await unread()).length).toBeLessThan(30_000);
  });

  it("caps the count and reports the true total", async () => {
    const r = await unread();
    expect(r.data.length).toBeLessThanOrEqual(20);
    expect(r.meta.total).toBe(36);
    expect(r.meta.returned).toBe(r.data.length);
  });

  // A cap without ordering hands back an arbitrary slice of the backlog.
  it("returns the newest first", async () => {
    const stamps = (await unread()).data.map((m: { createdAt: string }) => Date.parse(m.createdAt));
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });

  it("clips a long body, marks it, and keeps the real length", async () => {
    const m = (await unread()).data.find((x: { body: string }) => x.body.startsWith("note 34"));
    expect(m).toBeDefined();
    expect(m.body.length).toBeLessThan(1200);
    expect(m.truncated).toBe(true);
    expect(m.bodyLength).toBeGreaterThan(5000);
    expect(m.threadId).toBe(threadId);   // the handle you drill in with
  });

  it("collapses oversized message metadata to its keys", async () => {
    const m = (await unread()).data.find((x: { body: string }) => x.body.startsWith("note 34"));
    expect(m.metadata._truncated).toBe(true);
    expect(m.metadata.keys).toContain("files");
  });

  // Most messages are short. Clipping those would make an agent fetch a thread
  // to recover text it already had.
  it("leaves a short message completely intact", async () => {
    const m = (await unread()).data.find((x: { body: string }) => x.body === "short and whole");
    expect(m).toBeDefined();
    expect(m.truncated).toBeUndefined();
  });

  // event-worker's hasWork gate only asks "is there anything?".
  it("still reports work exists when the backlog is capped", async () => {
    expect((await unread()).data.length).toBeGreaterThan(0);
  });
});
