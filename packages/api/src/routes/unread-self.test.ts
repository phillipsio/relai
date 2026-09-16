import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-unread-self";
process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
let repoId: string, threadId: string;
let alice: string, aliceTok: string;
let bob: string, bobTok: string;

const unread = async (agentId: string, tok: string) => {
  const res = await app.inject({
    method: "GET", url: `/messages/unread?agentId=${agentId}&repoId=${repoId}`, headers: as(tok),
  });
  expect(res.statusCode).toBe(200);
  return res.json();
};

const startSession = async (tok: string) => {
  const res = await app.inject({ method: "GET", url: `/session/start?repoId=${repoId}`, headers: as(tok) });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

const post = async (tok: string, body: string) => {
  const res = await app.inject({
    method: "POST", url: `/threads/${threadId}/messages`, headers: as(tok),
    body: JSON.stringify({ type: "status", body }),
  });
  expect(res.statusCode).toBe(201);
  return res.json().data;
};

const bodies = (rows: { body: string }[]) => rows.map((m) => m.body);

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const r = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ unread-self" }),
  });
  repoId = r.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "alice", role: "worker" }),
  });
  alice = a.json().data.id;
  aliceTok = a.json().token;

  const b = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "bob", role: "worker" }),
  });
  bob = b.json().data.id;
  bobTok = b.json().token;

  const t = await app.inject({
    method: "POST", url: "/threads", headers: ADMIN,
    body: JSON.stringify({ repoId, title: "shared" }),
  });
  threadId = t.json().data.id;
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

describe("an agent's own outbound messages are not its own unread", () => {
  it("excludes the sender's message from GET /messages/unread and still delivers it to the recipient", async () => {
    await post(aliceTok, "alice-says-one");

    expect(bodies((await unread(alice, aliceTok)).data)).not.toContain("alice-says-one");
    expect(bodies((await unread(bob, bobTok)).data)).toContain("alice-says-one");
  });

  // The cap is what makes the feed safe, so a count that still includes the
  // sender's own traffic misreports the backlog even when the page is right.
  it("excludes the sender's message from meta.total, not only from the page", async () => {
    const before = (await unread(alice, aliceTok)).meta.total;
    await post(aliceTok, "alice-says-two");
    expect((await unread(alice, aliceTok)).meta.total).toBe(before);

    const bobBefore = (await unread(bob, bobTok)).meta.total;
    await post(aliceTok, "alice-says-three");
    expect((await unread(bob, bobTok)).meta.total).toBe(bobBefore + 1);
  });

  it("applies the same rule to /session/start, which has its own copy of the predicate", async () => {
    await post(aliceTok, "alice-says-four");

    const mine = await startSession(aliceTok);
    expect(bodies(mine.unreadMessages)).not.toContain("alice-says-four");

    const theirs = await startSession(bobTok);
    expect(bodies(theirs.unreadMessages)).toContain("alice-says-four");
  });

  it("excludes a DM the caller sent while leaving it unread for the recipient", async () => {
    const res = await app.inject({
      method: "POST", url: `/agents/${bob}/messages`, headers: as(aliceTok),
      body: JSON.stringify({ type: "question", body: "alice-dm-bob" }),
    });
    expect(res.statusCode).toBe(201);

    expect(bodies((await unread(alice, aliceTok)).data)).not.toContain("alice-dm-bob");
    expect(bodies((await unread(bob, bobTok)).data)).toContain("alice-dm-bob");
  });

  // Nothing in this file marks a thread read, so readBy is empty on every row
  // here and the query's sender term is the only thing that can exclude
  // alice's own message. Assert that emptiness rather than assuming it,
  // otherwise this passes for the wrong reason if a seed is ever added.
  it("excludes the sender on an empty readBy, which is every row", async () => {
    const m = await post(aliceTok, "alice-unseeded-row");

    const all = await app.inject({
      method: "GET", url: `/threads/${threadId}/messages`, headers: as(aliceTok),
    });
    const stored = all.json().data.find((x: { id: string }) => x.id === m.id);
    expect(stored.readBy).toEqual([]);

    expect(bodies((await unread(alice, aliceTok)).data)).not.toContain("alice-unseeded-row");
    expect(bodies((await unread(bob, bobTok)).data)).toContain("alice-unseeded-row");
  });

  // Guard against over-filtering: "human" is not an agent id, and an owner's
  // message has to stay unread for everyone.
  it("still delivers a human-authored message to every agent", async () => {
    await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: ADMIN,
      body: JSON.stringify({ fromAgent: "human", type: "question", body: "human-asks" }),
    });

    expect(bodies((await unread(alice, aliceTok)).data)).toContain("human-asks");
    expect(bodies((await unread(bob, bobTok)).data)).toContain("human-asks");
  });
});
