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
import { createDb, users, invites, tokens, deviceAuthorizations } from "@getrelai/db";
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

describe("approve states what it granted, so a downgrade cannot pass for success", () => {
  // An API that predates the scope field strips it (approveSchema is not
  // strict) and mints an ordinary repo token. Without an echo, a dashboard
  // offering an owner-scope checkbox would report success while handing the
  // user a repo-scoped credential.
  it("echoes owner when owner was granted", async () => {
    const { approve } = await grant({ owner: ownerA, repoId: repoA1, body: { scope: "owner" } });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().data.scope).toBe("owner");
  });

  it("echoes repo when nothing was asked for", async () => {
    const { approve } = await grant({ owner: ownerA, repoId: repoA1 });
    expect(approve.json().data.scope).toBe("repo");
  });

  it("reports the persisted scope rather than the requested one", async () => {
    // Reading it back from the update is what makes the echo worth trusting.
    const { userCode, approve } = await grant({ owner: ownerA, repoId: repoA1, body: { scope: "owner" } });
    expect(approve.json().data.scope).toBe("owner");

    const [row] = await db.select().from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, userCode));
    expect(row.scope).toBe(approve.json().data.scope);
  });
});

describe("owner scope is for the super agent, which is one orchestrator", () => {
  // The super agent is a proxy for the user, so it holds the user's authority
  // over the user's own tenant. That is only a coherent thing to grant to a
  // single orchestrator. An owner-scoped WORKER is the shape every finding in
  // the security review had in common, and refusing it at the grant removes
  // that class rather than guarding each consequence.
  it("refuses to grant owner scope to a worker", async () => {
    const started = await app.inject({
      method: "POST", url: "/auth/device/start", headers: JSON_ONLY, body: JSON.stringify({}),
    });
    const res = await app.inject({
      method: "POST", url: "/auth/device/approve", headers: asOwner(ownerA),
      body: JSON.stringify({
        userCode: started.json().data.userCode,
        repoId: repoA1,
        scope: "owner",
        agents: [{ name: `og-worker-${Date.now()}`, workerType: "claude", role: "worker" }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/orchestrator/i);
  });

  it("refuses a mixed grant, so one worker cannot ride along with an orchestrator", async () => {
    const started = await app.inject({
      method: "POST", url: "/auth/device/start", headers: JSON_ONLY, body: JSON.stringify({}),
    });
    const res = await app.inject({
      method: "POST", url: "/auth/device/approve", headers: asOwner(ownerA),
      body: JSON.stringify({
        userCode: started.json().data.userCode,
        repoId: repoA1,
        scope: "owner",
        agents: [
          { name: `og-mix-o-${Date.now()}`, workerType: "claude", role: "orchestrator" },
          { name: `og-mix-w-${Date.now()}`, workerType: "claude", role: "worker" },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("still allows a worker in an ordinary repo grant", async () => {
    const started = await app.inject({
      method: "POST", url: "/auth/device/start", headers: JSON_ONLY, body: JSON.stringify({}),
    });
    const res = await app.inject({
      method: "POST", url: "/auth/device/approve", headers: asOwner(ownerA),
      body: JSON.stringify({
        userCode: started.json().data.userCode,
        repoId: repoA1,
        agents: [{ name: `og-plainworker-${Date.now()}`, workerType: "claude", role: "worker" }],
      }),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("rotation keeps the super agent's scope", () => {
  // Rotation revokes what it replaces inside one transaction, so a rotation
  // that dropped ownerId would kill the credential and leave no route to
  // re-grant it: owner scope reaches a token only through invites.ownerId.
  it("carries ownerId onto the replacement token", async () => {
    const { deviceCode } = await grant({ owner: ownerA, repoId: repoA1, body: { scope: "owner" } });
    const { token, agentId } = await redeem(deviceCode, `og-rot-${Date.now()}`);

    const rotated = await app.inject({
      method: "POST", url: `/agents/${agentId}/tokens`, headers: as(token),
      body: JSON.stringify({}),
    });
    expect(rotated.statusCode).toBe(201);

    const fresh = rotated.json().token as string;
    const live = (await db.select().from(tokens).where(eq(tokens.agentId, agentId)))
      .filter((t) => t.revokedAt === null);
    expect(live.length).toBe(1);
    expect(live[0].ownerId).toBe(ownerA);

    // And it still works across repos, which is the property that matters.
    const sibling = await app.inject({ method: "GET", url: `/repos/${repoA2}`, headers: as(fresh) });
    expect(sibling.statusCode).toBe(200);
  });
});

describe("rotation must not hand the super agent's scope to a peer", () => {
  // callerMayActOnAgent admits ANY orchestrator in the target's repo, so
  // rotation is reachable by a peer. Copying the TARGET's ownerId onto the
  // token returned to the CALLER turns that into an escalation: an ordinary
  // repo-scoped orchestrator mints itself the user's tenant-wide authority,
  // and `keepExisting` means the super agent keeps working so nothing alerts.
  it("gives a peer orchestrator a repo-scoped token, not the owner's", async () => {
    const { deviceCode } = await grant({ owner: ownerA, repoId: repoA1, body: { scope: "owner" } });
    const { agentId: superId } = await redeem(deviceCode, `og-super-${Date.now()}`);

    const peer = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId: repoA1, name: `og-peer-${Date.now()}`, role: "orchestrator" }),
    });
    const peerToken = peer.json().token as string;
    // Baseline: the peer cannot reach the sibling repo.
    expect((await app.inject({ method: "GET", url: `/repos/${repoA2}`, headers: as(peerToken) })).statusCode).toBe(403);

    const stolen = await app.inject({
      method: "POST", url: `/agents/${superId}/tokens`, headers: as(peerToken),
      body: JSON.stringify({ keepExisting: true }),
    });
    expect(stolen.statusCode).toBe(201);

    // The credential it just received must NOT carry the owner's scope.
    const reach = await app.inject({
      method: "GET", url: `/repos/${repoA2}`, headers: as(stolen.json().token as string),
    });
    expect(reach.statusCode).toBe(403);
  });

  it("preserves scope when the super agent rotates itself", async () => {
    const { deviceCode } = await grant({ owner: ownerA, repoId: repoA1, body: { scope: "owner" } });
    const { token, agentId } = await redeem(deviceCode, `og-self-${Date.now()}`);

    const rotated = await app.inject({
      method: "POST", url: `/agents/${agentId}/tokens`, headers: as(token),
      body: JSON.stringify({}),
    });
    expect(rotated.statusCode).toBe(201);
    const fresh = rotated.json().token as string;
    expect((await app.inject({ method: "GET", url: `/repos/${repoA2}`, headers: as(fresh) })).statusCode).toBe(200);
  });

  it("does not resurrect scope from a revoked row after a de-scoping revoke", async () => {
    // Revoking every credential is an operator's only containment lever. It
    // must not be undone by the next rotation reading the row it just killed.
    const { deviceCode } = await grant({ owner: ownerA, repoId: repoA1, body: { scope: "owner" } });
    const { agentId } = await redeem(deviceCode, `og-revoked-${Date.now()}`);

    for (const row of await db.select().from(tokens).where(eq(tokens.agentId, agentId))) {
      await app.inject({ method: "DELETE", url: `/tokens/${row.id}`, headers: ADMIN });
    }

    const reissued = await app.inject({
      method: "POST", url: `/agents/${agentId}/tokens`, headers: ADMIN, body: JSON.stringify({}),
    });
    expect(reissued.statusCode).toBe(201);
    const reach = await app.inject({
      method: "GET", url: `/repos/${repoA2}`, headers: as(reissued.json().token as string),
    });
    expect(reach.statusCode).not.toBe(200);
  });

  it("makes owner scope visible, so a stolen one is findable", async () => {
    const { deviceCode } = await grant({ owner: ownerA, repoId: repoA1, body: { scope: "owner" } });
    const { token, agentId } = await redeem(deviceCode, `og-visible-${Date.now()}`);

    const listed = await app.inject({ method: "GET", url: `/agents/${agentId}/tokens`, headers: as(token) });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json().data as Array<{ ownerScoped: boolean }>;
    expect(rows.some((r) => r.ownerScoped === true)).toBe(true);
    // Never the owner id itself, and never anything hash-shaped.
    expect(listed.body).not.toMatch(/[0-9a-f]{64}/);
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
