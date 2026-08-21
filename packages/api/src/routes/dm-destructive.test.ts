import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import { createDb, users, repos } from "@getrelai/db";
import { eq } from "drizzle-orm";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-dm-destructive";
process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
const db = createDb(DB_URL);
const OWNER = "usr_dmdel";
let repoA: string, repoB: string, aliceTok: string, bobTok: string;
// One DM per case: a destructive test that runs first otherwise leaves the
// later ones asserting 404 against a thread that is simply gone.
const peers: Record<string, { id: string; token: string; thread: string }> = {};

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
  await db.insert(users).values({ id: OWNER, email: "dmdel@example.com" }).onConflictDoNothing();

  const mkRepo = async (n: string) => {
    const r = await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name: n }) });
    const id = r.json().data.id as string;
    await db.update(repos).set({ ownerId: OWNER }).where(eq(repos.id, id));
    return id;
  };
  repoA = await mkRepo("__test__ dmdel A");
  repoB = await mkRepo("__test__ dmdel B");

  const mkAgent = async (repoId: string, name: string) => {
    const a = await app.inject({ method: "POST", url: "/agents", headers: ADMIN, body: JSON.stringify({ repoId, name, role: "worker" }) });
    return { id: a.json().data.id as string, token: a.json().token as string };
  };
  const alice = await mkAgent(repoA, "dmdel-alice");
  const bob = await mkAgent(repoA, "dmdel-bob");         // alice's repo-mate, NOT in the DM
  aliceTok = alice.token; bobTok = bob.token;

  for (const k of ["del", "conclude", "archive", "participant", "admin"]) {
    const c = await mkAgent(repoB, `dmdel-peer-${k}`);
    const sent = await app.inject({
      method: "POST", url: `/agents/${c.id}/messages`, headers: as(aliceTok),
      body: JSON.stringify({ type: "question", body: `private: rotate the staging key (${k})` }),
    });
    peers[k] = { id: c.id, token: c.token, thread: sent.json().data.threadId };
  }
});

afterAll(async () => {
  for (const r of [repoA, repoB]) if (r) await app.inject({ method: "DELETE", url: `/repos/${r}`, headers: ADMIN });
  await db.delete(users).where(eq(users.id, OWNER));
  await app?.close();
});

// A DM is private to its two participants on read, so its lifecycle must honour
// the same boundary. Deletion is refused outright even for participants: it
// destroys the other person's messages, and archive already means "make it go
// away". The operator paths keep it, as they keep read.
describe("DM privacy covers the thread lifecycle, not just reads", () => {
  it("hides the thread from a non-participant repo-mate on every route", async () => {
    const p = peers.del;
    for (const call of [
      { method: "GET" as const,    url: `/threads/${p.thread}/messages` },
      { method: "DELETE" as const, url: `/threads/${p.thread}` },
      { method: "PUT" as const,    url: `/threads/${p.thread}/conclude` },
      { method: "PUT" as const,    url: `/threads/${p.thread}/archive` },
    ]) {
      const res = await app.inject({ ...call, headers: as(bobTok), body: JSON.stringify({}) });
      expect(`${call.method} ${call.url} -> ${res.statusCode}`).toBe(`${call.method} ${call.url} -> 404`);
    }

    const survived = await app.inject({ method: "GET", url: `/threads/${p.thread}/messages`, headers: as(p.token) });
    expect(survived.statusCode).toBe(200);
    expect(survived.json().data).toHaveLength(1);
  });

  it("lets a participant conclude their own DM from another repo", async () => {
    const p = peers.conclude;
    const res = await app.inject({
      method: "PUT", url: `/threads/${p.thread}/conclude`, headers: as(p.token),
      body: JSON.stringify({ summary: "answered" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("concluded");
  });

  it("lets a participant archive their own concluded DM", async () => {
    const p = peers.archive;
    await app.inject({
      method: "PUT", url: `/threads/${p.thread}/conclude`, headers: as(p.token),
      body: JSON.stringify({ summary: "done" }),
    });
    const res = await app.inject({ method: "PUT", url: `/threads/${p.thread}/archive`, headers: as(p.token), body: JSON.stringify({}) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.archivedAt).toBeTruthy();
  });

  // Archive is the participant's "make it go away". Delete would take the other
  // participant's copy with it, so it is refused with a pointer, not silently.
  it("refuses deletion even by a participant, and says what to do instead", async () => {
    const p = peers.participant;
    const res = await app.inject({ method: "DELETE", url: `/threads/${p.thread}`, headers: as(p.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/archive/i);

    const stillThere = await app.inject({ method: "GET", url: `/threads/${p.thread}/messages`, headers: as(aliceTok) });
    expect(stillThere.statusCode).toBe(200);
  });

  it("also refuses the sender, so neither side can erase the other's copy", async () => {
    const res = await app.inject({ method: "DELETE", url: `/threads/${peers.participant.thread}`, headers: as(aliceTok) });
    expect(res.statusCode).toBe(403);
  });

  // Privacy here is between agents, not from the operator, matching read access.
  it("still lets the operator path delete a DM", async () => {
    const res = await app.inject({ method: "DELETE", url: `/threads/${peers.admin.thread}`, headers: ADMIN });
    expect(res.statusCode).toBe(204);
  });
});

describe("ordinary threads are unaffected by the merge", () => {
  it("still lets a repo-mate delete a normal thread", async () => {
    const t = await app.inject({
      method: "POST", url: "/threads", headers: ADMIN, body: JSON.stringify({ repoId: repoA, title: "ordinary" }),
    });
    const res = await app.inject({ method: "DELETE", url: `/threads/${t.json().data.id}`, headers: as(bobTok) });
    expect(res.statusCode).toBe(204);
  });

  it("still refuses a thread in another repo", async () => {
    const t = await app.inject({
      method: "POST", url: "/threads", headers: ADMIN, body: JSON.stringify({ repoId: repoB, title: "foreign" }),
    });
    const res = await app.inject({ method: "DELETE", url: `/threads/${t.json().data.id}`, headers: as(bobTok) });
    expect(res.statusCode).toBe(404);
  });
});
