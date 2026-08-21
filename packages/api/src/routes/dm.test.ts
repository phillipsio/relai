import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import { createDb, users, repos, subscriptions } from "@getrelai/db";
import { eq } from "drizzle-orm";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-dm";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
const db = createDb(DB_URL);

const OWNER = "usr_dm_owner";
const OTHER_OWNER = "usr_dm_other";

let repoA: string, repoB: string, repoC: string;
let alice: string, aliceTok: string;
let bob: string, bobTok: string;
let carol: string, carolTok: string;
let dave: string;

const dm = (token: string, toAgent: string, body: string, type = "question") =>
  app.inject({
    method: "POST", url: `/agents/${toAgent}/messages`, headers: as(token),
    body: JSON.stringify({ body, type }),
  });

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  for (const id of [OWNER, OTHER_OWNER]) {
    await db.insert(users).values({ id, email: `${id}@example.com` }).onConflictDoNothing();
  }

  // ownerId is not settable through POST /repos, so stamp it directly.
  const mkRepo = async (name: string, ownerId: string) => {
    const r = await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name }) });
    const id = r.json().data.id as string;
    await db.update(repos).set({ ownerId }).where(eq(repos.id, id));
    return id;
  };
  repoA = await mkRepo("__test__ dm A", OWNER);
  repoB = await mkRepo("__test__ dm B", OWNER);
  repoC = await mkRepo("__test__ dm C", OTHER_OWNER);

  const mkAgent = async (repoId: string, name: string) => {
    const a = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name, role: "worker" }),
    });
    return { id: a.json().data.id as string, token: a.json().token as string };
  };
  ({ id: alice, token: aliceTok } = await mkAgent(repoA, "dm-alice"));
  ({ id: bob,   token: bobTok   } = await mkAgent(repoA, "dm-bob"));
  ({ id: carol, token: carolTok } = await mkAgent(repoB, "dm-carol"));
  ({ id: dave }                  = await mkAgent(repoC, "dm-dave"));
});

afterAll(async () => {
  for (const r of [repoA, repoB, repoC]) {
    if (r) await app.inject({ method: "DELETE", url: `/repos/${r}`, headers: ADMIN });
  }
  for (const u of [OWNER, OTHER_OWNER]) await db.delete(users).where(eq(users.id, u));
  await app?.close();
});

describe("addressing an agent without finding a thread first", () => {
  it("creates the thread on the first message", async () => {
    const res = await dm(aliceTok, bob, "do you have the schema doc?");
    expect(res.statusCode).toBe(201);
    expect(res.json().data.threadId).toMatch(/^thread_/);
    expect(res.json().data.message.fromAgent).toBe(alice);
    expect(res.json().data.message.toAgent).toBe(bob);
  });

  it("reuses that thread rather than making a second one", async () => {
    const first = await dm(aliceTok, bob, "one");
    const again = await dm(aliceTok, bob, "two");
    expect(again.json().data.threadId).toBe(first.json().data.threadId);
  });

  // The pair is unordered: a reply must land in the same conversation, not a
  // mirror-image thread nobody reads.
  it("resolves to the same thread when the peer answers", async () => {
    const out = await dm(aliceTok, bob, "ping");
    const back = await dm(bobTok, alice, "pong", "reply");
    expect(back.json().data.threadId).toBe(out.json().data.threadId);
  });

  it("refuses a message to yourself", async () => {
    const res = await dm(aliceTok, alice, "note to self");
    expect(res.statusCode).toBe(400);
  });
});

describe("reach matches what the directory shows", () => {
  it("reaches a peer in a sibling repo under the same owner", async () => {
    const res = await dm(aliceTok, carol, "can you review the router change?");
    expect(res.statusCode).toBe(201);
  });

  it("does not reach an agent belonging to another owner", async () => {
    const res = await dm(aliceTok, dave, "hello stranger");
    expect(res.statusCode).toBe(404);
  });
});

describe("a DM is private to its two participants", () => {
  let aliceCarol: string;

  beforeAll(async () => {
    const res = await dm(aliceTok, carol, "private: the staging key rotates friday");
    aliceCarol = res.json().data.threadId;
  });

  it("lets the recipient read it from another repo", async () => {
    const res = await app.inject({ method: "GET", url: `/threads/${aliceCarol}/messages`, headers: as(carolTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((m: { body: string }) => m.body))
      .toContain("private: the staging key rotates friday");
  });

  it("lets the recipient mark it read", async () => {
    const res = await app.inject({
      method: "PUT", url: `/threads/${aliceCarol}/messages/read`, headers: as(carolTok),
      body: JSON.stringify({ agentId: carol }),
    });
    expect(res.statusCode).toBe(200);
  });

  // bob shares repo A with alice, and the thread row lives in repo A, so
  // repo-wide thread access would hand him someone else's conversation.
  it("hides it from a repo-mate who is not in it", async () => {
    const read = await app.inject({ method: "GET", url: `/threads/${aliceCarol}/messages`, headers: as(bobTok) });
    expect(read.statusCode).toBe(404);

    const post = await app.inject({
      method: "POST", url: `/threads/${aliceCarol}/messages`, headers: as(bobTok),
      body: JSON.stringify({ type: "reply", body: "butting in" }),
    });
    expect(post.statusCode).toBe(404);
  });

  it("keeps DMs out of the repo thread list", async () => {
    const res = await app.inject({ method: "GET", url: "/threads", headers: as(aliceTok) });
    const ids = res.json().data.map((t: { id: string }) => t.id);
    expect(ids).not.toContain(aliceCarol);
  });
});

describe("a cross-repo DM still lands in the recipient's inbox", () => {
  it("appears in the unread feed scoped to the recipient's own repo", async () => {
    const sent = await dm(aliceTok, carol, "unread-probe: please confirm the migration ran");
    const res = await app.inject({
      method: "GET", url: `/messages/unread?agentId=${carol}&repoId=${repoB}`, headers: as(carolTok),
    });
    expect(res.statusCode).toBe(200);
    const bodies = res.json().data.map((m: { body: string }) => m.body);
    expect(bodies).toContain("unread-probe: please confirm the migration ran");
    expect(sent.json().data.threadId).toBeTruthy();
  });

  // The event row carries the SENDER's repoId, and recentEvents filters on the
  // caller's, so a cross-repo DM was posted, delivered and unread-listed while
  // being invisible in the one feed that says "here is what happened".
  it("appears in the recipient's recentEvents, not only their unread list", async () => {
    const sent = await dm(aliceTok, carol, "events-probe: the migration needs re-running");
    const res = await app.inject({ method: "GET", url: `/session/start?repoId=${repoB}`, headers: as(carolTok) });

    const forThread = res.json().data.recentEvents
      .filter((e: { targetId: string }) => e.targetId === sent.json().data.threadId);
    expect(forThread.length).toBeGreaterThan(0);
    expect(forThread[0].summary).toContain("events-probe");
  });

  // Widening the repo filter must widen it only for DM participants.
  it("does not put the DM in an uninvolved repo-mate's recentEvents", async () => {
    const sent = await dm(aliceTok, carol, "events-privacy-probe: rotate the staging key");
    const res = await app.inject({ method: "GET", url: `/session/start?repoId=${repoA}`, headers: as(bobTok) });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.recentEvents
      .some((e: { targetId: string }) => e.targetId === sent.json().data.threadId)).toBe(false);
  });

  it("appears in the recipient's session_start bundle", async () => {
    await dm(aliceTok, carol, "session-probe: are you free to pair?");
    const res = await app.inject({ method: "GET", url: `/session/start?repoId=${repoB}`, headers: as(carolTok) });
    expect(res.statusCode).toBe(200);
    const bodies = res.json().data.unreadMessages.map((m: { body: string }) => m.body);
    expect(bodies).toContain("session-probe: are you free to pair?");
  });

  // The sender must not pick up the recipient's repo along with the thread.
  it("does not leak the sibling repo's own messages to the sender", async () => {
    const t = await app.inject({
      method: "POST", url: "/threads", headers: ADMIN,
      body: JSON.stringify({ repoId: repoB, title: "repo B internal" }),
    });
    await app.inject({
      method: "POST", url: `/threads/${t.json().data.id}/messages`, headers: as(carolTok),
      body: JSON.stringify({ type: "status", body: "internal-only chatter" }),
    });

    const res = await app.inject({
      method: "GET", url: `/messages/unread?agentId=${alice}&repoId=${repoA}`, headers: as(aliceTok),
    });
    const bodies = res.json().data.map((m: { body: string }) => m.body);
    expect(bodies).not.toContain("internal-only chatter");
  });
});

// The DM exception widens a tenancy filter, so the filter it widens needs a
// test of its own. `resolveSubscribers` matches on target alone with no repo
// check, which makes a stray cross-repo subscription row a standing leak; the
// repo predicate in recentEvents is the layer that contains it.
describe("the events feed stays repo-scoped for everything that is not a DM", () => {
  it("hides another repo's thread events even from an agent subscribed to them", async () => {
    const foreign = await app.inject({
      method: "POST", url: "/threads", headers: ADMIN,
      body: JSON.stringify({ repoId: repoB, title: "repo B internal thread" }),
    });
    const foreignThread = foreign.json().data.id as string;

    // Written directly: POST /subscriptions refuses to cross repos, which is
    // exactly the guard we are assuming has failed.
    await db.insert(subscriptions).values({
      id: `sub_leak_${Date.now()}`, agentId: alice, targetType: "thread", targetId: foreignThread,
    }).onConflictDoNothing();

    await app.inject({
      method: "POST", url: `/threads/${foreignThread}/messages`, headers: as(carolTok),
      body: JSON.stringify({ type: "finding", body: "leak-probe: repo B internal finding" }),
    });

    const res = await app.inject({ method: "GET", url: `/session/start?repoId=${repoA}`, headers: as(aliceTok) });
    expect(res.statusCode).toBe(200);
    const events = res.json().data.recentEvents as Array<{ targetId: string; summary: string }>;
    expect(events.some((e) => e.targetId === foreignThread)).toBe(false);
    expect(events.some((e) => e.summary?.includes("leak-probe"))).toBe(false);
  });
});
