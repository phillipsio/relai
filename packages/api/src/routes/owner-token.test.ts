// An owner credential that carries its own scope.
//
// Today the only cross-repo identity is SERVICE_ADMIN_TOKEN plus a caller-set
// X-Owner-Id header. That is one instance-wide secret where the header picks
// the tenant, so possession of it is possession of every tenant on the box. It
// is safe only because exactly one trusted caller sets that header. Hand a
// per-tenant agent a credential on that path and the header stops being a
// control and becomes a convention: any holder names any tenant by rewriting
// one string.
//
// `tokens.ownerId` moves the scope into the credential. A token that carries
// its own owner cannot name a different one, because nothing in the request
// says who the owner is.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, tokens, users } from "@getrelai/db";
import { eq } from "drizzle-orm";
import { hashToken } from "../lib/tokens.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-owner-token";
const SERVICE = "test-service-admin-owner-token";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;
process.env.SERVICE_ADMIN_TOKEN = SERVICE;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
// The dashboard's path: the instance-wide secret plus a header naming the
// tenant. This is what tokens.ownerId exists to stop being the only option.
const asOwner = (owner: string) => ({
  Authorization: `Bearer ${SERVICE}`,
  "X-Owner-Id": owner,
  "Content-Type": "application/json",
});
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

const db = createDb(DB_URL);
let app: FastifyInstance;

const ownerA = `usr_ot_a_${Date.now()}`;
const ownerB = `usr_ot_b_${Date.now()}`;
let repoA1: string;   // owned by A, home of the owner-scoped agent
let repoA2: string;   // owned by A, a sibling the agent must reach
let repoB: string;    // owned by B, which it must not
let agentInA1: string;
let plainToken: string;   // repo-scoped, no ownerId
let ownerToken: string;   // same agent, but the token carries ownerId

const mkRepo = async (name: string, owner: string) => {
  const r = await app.inject({
    method: "POST", url: "/repos",
    headers: asOwner(owner),
    body: JSON.stringify({ name }),
  });
  return r.json().data.id as string;
};

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  await db.insert(users).values([
    { id: ownerA, email: `${ownerA}@test.invalid` },
    { id: ownerB, email: `${ownerB}@test.invalid` },
  ]);

  repoA1 = await mkRepo("__test__ ot A1", ownerA);
  repoA2 = await mkRepo("__test__ ot A2", ownerA);
  repoB  = await mkRepo("__test__ ot B", ownerB);

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId: repoA1, name: "ot-owner-agent", role: "orchestrator" }),
  });
  agentInA1 = a.json().data.id;
  plainToken = a.json().token;

  // The owner-scoped credential. Minting it through device auth is the next
  // slice; the row is what these tests are about.
  ownerToken = "aio_ot_owner_scoped_fixture_token";
  await db.insert(tokens).values({
    id: `tok_ot_${Date.now()}`,
    agentId: agentInA1,
    ownerId: ownerA,
    tokenHash: hashToken(ownerToken),
  });
});

afterAll(async () => {
  for (const id of [repoA1, repoA2, repoB]) {
    if (id) await app.inject({ method: "DELETE", url: `/repos/${id}`, headers: ADMIN });
  }
  await db.delete(users).where(eq(users.id, ownerA));
  await db.delete(users).where(eq(users.id, ownerB));
  await app?.close();
});

describe("the scope comes from the token row, not from a header", () => {
  it("reaches a sibling repo owned by the same user", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/${repoA2}`, headers: as(ownerToken) });
    expect(res.statusCode).toBe(200);
  });

  it("still reaches its own home repo, which is what identity and messages hang off", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/${repoA1}`, headers: as(ownerToken) });
    expect(res.statusCode).toBe(200);
  });

  it("cannot reach a repo owned by anyone else", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/${repoB}`, headers: as(ownerToken) });
    expect(res.statusCode).not.toBe(200);
  });

  it("ignores an X-Owner-Id the caller supplies, because the row already decided", async () => {
    // The whole point of moving scope into the credential: a holder must not be
    // able to name a tenant by rewriting a string.
    const res = await app.inject({
      method: "GET", url: `/repos/${repoB}`,
      headers: { ...as(ownerToken), "X-Owner-Id": ownerB },
    });
    expect(res.statusCode).not.toBe(200);
  });
});

describe("no collateral widening for ordinary tokens", () => {
  it("the same agent's plain token still cannot see the sibling repo", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/${repoA2}`, headers: as(plainToken) });
    expect(res.statusCode).toBe(403);
  });

  it("and still reaches its own", async () => {
    const res = await app.inject({ method: "GET", url: `/repos/${repoA1}`, headers: as(plainToken) });
    expect(res.statusCode).toBe(200);
  });
});

describe("the other two scoping sites, checked rather than assumed", () => {
  // Criterion 4 names assertRepoAccess and peerRepoIds. The first needed the
  // new arm; the second turns out not to, because it already keys on the
  // agent's repo's OWNER rather than on the caller's credential. Pinned so the
  // next person does not have to re-derive that, and so a change to it is
  // deliberate.
  it("sees peers across the owner's repos, which peerRepoIds already allowed", async () => {
    const peer = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId: repoA2, name: "ot-sibling-peer", role: "worker" }),
    });
    expect(peer.statusCode).toBe(201);

    const res = await app.inject({ method: "GET", url: "/agents", headers: as(ownerToken) });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(peer.json().data.id);
  });

  it("scopedAgentIds stays narrow: an owner-scoped agent manages only its own subscriptions", async () => {
    // A row belonging to SOMEONE ELSE has to exist or this asserts nothing:
    // the first version of this test ran `every()` over an empty array and
    // stayed green against a deliberately widened scopedAgentIds.
    const peer = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId: repoA2, name: `ot-sub-peer-${Date.now()}`, role: "worker" }),
    });
    const peerId = peer.json().data.id as string;

    for (const [agentId, token] of [[agentInA1, ownerToken], [peerId, peer.json().token]] as const) {
      const t = await app.inject({
        method: "POST", url: "/threads", headers: as(token),
        body: JSON.stringify({ repoId: agentId === peerId ? repoA2 : repoA1, title: `sub-${agentId}` }),
      });
      const sub = await app.inject({
        method: "POST", url: "/subscriptions", headers: as(token),
        body: JSON.stringify({ agentId, targetType: "thread", targetId: t.json().data.id }),
      });
      expect(sub.statusCode).toBe(201);
    }

    const res = await app.inject({ method: "GET", url: "/subscriptions", headers: as(ownerToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ agentId: string }>;
    // Non-empty is the guard; the peer's row exists and must not appear.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.agentId === agentInA1)).toBe(true);
    expect(rows.some((r) => r.agentId === peerId)).toBe(false);
  });
});

describe("an owner-scoped agent is an agent, not a person", () => {
  // The ticket feared that agent-first branching would kill remote unblocking.
  // It is the other way round: the dashboard path carries no request.agent, so
  // it keeps stamping human, while an owner-scoped AGENT must not — otherwise
  // an agent can resolve an escalation raised to a person, which is the same
  // defect as a task's assignee approving its own review.
  let threadId: string;

  beforeAll(async () => {
    const t = await app.inject({
      method: "POST", url: "/threads", headers: as(plainToken),
      body: JSON.stringify({ repoId: repoA1, title: "ot authorship" }),
    });
    threadId = t.json().data.id;
  });

  it("stamps authorKind agent when the credential carries an owner", async () => {
    const res = await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: as(ownerToken),
      body: JSON.stringify({ type: "status", body: "from the owner's agent" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.authorKind).toBe("agent");
    expect(res.json().data.fromAgent).toBe(agentInA1);
  });

  it("while the dashboard path still stamps human, so unblocking is untouched", async () => {
    const res = await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`,
      headers: asOwner(ownerA),
      body: JSON.stringify({ type: "status", body: "from a person in a browser" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.authorKind).toBe("human");
    expect(res.json().data.fromAgent).toBe("human");
  });
});
