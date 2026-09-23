// Minting an owner-scoped credential, end to end.
//
// Slice one put `tokens.ownerId` in the schema and taught auth to read it, but
// left no way to obtain one — deliberately, so no token could exist whose
// meaning had not been reviewed. This is the way to obtain one.
//
// The scope travels: approve records it on the device row, the poll mints an
// invite carrying the owner, and accept-invite copies it onto the token. It has
// to travel rather than being decided at the end, because invites are minted at
// poll time specifically so a code never sits at rest, which is long after the
// human made the decision.
//
// The property that matters most: the owner stamped on the credential comes
// from the APPROVER's own authenticated scope, never from a request body. A
// caller cannot mint itself a token for a tenant it does not hold.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, users, invites, tokens } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-owner-grant";
const SERVICE = "test-service-admin-owner-grant";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;
process.env.SERVICE_ADMIN_TOKEN = SERVICE;
process.env.DEVICE_START_RATE_LIMIT = "100000";
process.env.RELAI_DASHBOARD_URL = "https://dash.example.test";

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const JSON_ONLY = { "Content-Type": "application/json" };
const asOwner = (owner: string) => ({
  Authorization: `Bearer ${SERVICE}`,
  "X-Owner-Id": owner,
  "Content-Type": "application/json",
});
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

const db = createDb(DB_URL);
let app: FastifyInstance;

const ownerA = `usr_og_a_${Date.now()}`;
const ownerB = `usr_og_b_${Date.now()}`;
let repoA1: string;
let repoA2: string;

const mkRepo = async (name: string, owner: string) =>
  (await app.inject({ method: "POST", url: "/repos", headers: asOwner(owner), body: JSON.stringify({ name }) }))
    .json().data.id as string;

// The full dance: start, approve, poll for invites, redeem one into a token.
async function grant(opts: { owner: string; repoId: string; body?: Record<string, unknown> }) {
  const started = await app.inject({
    method: "POST", url: "/auth/device/start", headers: JSON_ONLY, body: JSON.stringify({}),
  });
  const { userCode } = started.json().data;
  const deviceCode = started.json().deviceCode as string;

  const approve = await app.inject({
    method: "POST", url: "/auth/device/approve", headers: asOwner(opts.owner),
    body: JSON.stringify({
      userCode,
      repoId: opts.repoId,
      agents: [{ name: `og-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, workerType: "claude", role: "orchestrator" }],
      ...(opts.body ?? {}),
    }),
  });

  return { userCode, deviceCode, approve };
}

async function redeem(deviceCode: string, name: string) {
  // The device code is the credential here, so it rides in Authorization.
  const polled = await app.inject({
    method: "POST", url: "/auth/device/token",
    headers: { Authorization: `Bearer ${deviceCode}`, ...JSON_ONLY },
  });
  expect(polled.statusCode).toBe(200);
  const code = polled.json().invites[0].code as string;

  const accepted = await app.inject({
    method: "POST", url: "/auth/accept-invite", headers: JSON_ONLY,
    body: JSON.stringify({ code, name, role: "orchestrator" }),
  });
  expect(accepted.statusCode).toBe(201);
  return { token: accepted.json().token as string, agentId: accepted.json().data.id as string, code };
}

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
  await db.insert(users).values([
    { id: ownerA, email: `${ownerA}@test.invalid` },
    { id: ownerB, email: `${ownerB}@test.invalid` },
  ]);
  repoA1 = await mkRepo("__test__ og A1", ownerA);
  repoA2 = await mkRepo("__test__ og A2", ownerA);
});

afterAll(async () => {
  for (const id of [repoA1, repoA2]) {
    if (id) await app.inject({ method: "DELETE", url: `/repos/${id}`, headers: ADMIN });
  }
  await db.delete(users).where(eq(users.id, ownerA));
  await db.delete(users).where(eq(users.id, ownerB));
  await app?.close();
});

describe("today's grant is unchanged when nobody asks for anything else", () => {
  // relai-cloud sends no scope field. If this breaks, every existing approval
  // breaks with it.
  it("mints a repo-scoped token that cannot see a sibling repo", async () => {
    const { deviceCode, approve } = await grant({ owner: ownerA, repoId: repoA1 });
    expect(approve.statusCode).toBe(200);

    const { token } = await redeem(deviceCode, `og-plain-${Date.now()}`);

    const own = await app.inject({ method: "GET", url: `/repos/${repoA1}`, headers: as(token) });
    expect(own.statusCode).toBe(200);
    const sibling = await app.inject({ method: "GET", url: `/repos/${repoA2}`, headers: as(token) });
    expect(sibling.statusCode).toBe(403);
  });
});

describe("an owner-scoped grant, end to end", () => {
  it("produces a credential that reads across the owner's repos", async () => {
    const { deviceCode, approve } = await grant({
      owner: ownerA, repoId: repoA1, body: { scope: "owner" },
    });
    expect(approve.statusCode).toBe(200);

    const { token, agentId } = await redeem(deviceCode, `og-owner-${Date.now()}`);

    // The whole point of the slice.
    const sibling = await app.inject({ method: "GET", url: `/repos/${repoA2}`, headers: as(token) });
    expect(sibling.statusCode).toBe(200);

    // And the agent still has a home repo, because agents.repoId is NOT NULL.
    const rows = await db.select().from(tokens).where(eq(tokens.agentId, agentId));
    expect(rows[0].ownerId).toBe(ownerA);
  });

  it("carries the owner on the invite, which is how it reaches the token at all", async () => {
    const { deviceCode } = await grant({ owner: ownerA, repoId: repoA1, body: { scope: "owner" } });
    const { code } = await redeem(deviceCode, `og-invite-${Date.now()}`);

    const { createHash } = await import("node:crypto");
    const [row] = await db.select().from(invites)
      .where(eq(invites.codeHash, createHash("sha256").update(code).digest("hex")));
    expect(row.ownerId).toBe(ownerA);
  });
});

describe("the owner comes from the approver, never from the request", () => {
  it("ignores an ownerId in the body and uses the approving tenant", async () => {
    // A caller holding owner A's session must not mint a credential for B by
    // typing B's id. The field is not in the schema, so it is stripped; this
    // pins the OUTCOME rather than the mechanism, which survives a refactor.
    const { deviceCode } = await grant({
      owner: ownerA, repoId: repoA1, body: { scope: "owner", ownerId: ownerB },
    });
    const { agentId } = await redeem(deviceCode, `og-forge-${Date.now()}`);

    const rows = await db.select().from(tokens).where(eq(tokens.agentId, agentId));
    expect(rows[0].ownerId).toBe(ownerA);
    expect(rows[0].ownerId).not.toBe(ownerB);
  });

  it("refuses an owner grant from the shared-secret path, which holds no owner", async () => {
    // A self-hoster's API_SECRET has no tenant. Minting an owner-scoped token
    // there would bind it to nothing and hand out a credential whose scope
    // cannot be reasoned about.
    process.env.DEVICE_ALLOW_LEGACY_SECRET = "true";
    try {
      const started = await app.inject({
        method: "POST", url: "/auth/device/start", headers: JSON_ONLY, body: JSON.stringify({}),
      });
      const res = await app.inject({
        method: "POST", url: "/auth/device/approve", headers: ADMIN,
        body: JSON.stringify({
          userCode: started.json().data.userCode,
          repoId: repoA1,
          scope: "owner",
          agents: [{ name: `og-legacy-${Date.now()}`, workerType: "claude", role: "orchestrator" }],
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/owner/i);
    } finally {
      delete process.env.DEVICE_ALLOW_LEGACY_SECRET;
    }
  });
});
