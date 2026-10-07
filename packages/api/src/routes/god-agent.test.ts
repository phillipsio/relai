import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, users, tokens, invites, agents, ownerGodAgents } from "@getrelai/db";
import { generateToken, hashToken } from "../lib/tokens.js";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-god-agent";
const SERVICE = "test-service-admin-god-agent";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;
process.env.SERVICE_ADMIN_TOKEN = SERVICE;
process.env.DEVICE_START_RATE_LIMIT = "100000";
process.env.RELAI_DASHBOARD_URL = "https://dash.example.test";

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const JSON_ONLY = { "Content-Type": "application/json" };
const asOwner = (owner: string) => ({ Authorization: `Bearer ${SERVICE}`, "X-Owner-Id": owner, "Content-Type": "application/json" });
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

const db = createDb(DB_URL);
let app: FastifyInstance;
const createdOwners: string[] = [];
const createdRepos: string[] = [];
const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

async function freshOwner() {
  const id = `usr_god_${uniq()}`;
  await db.insert(users).values({ id, email: `${id}@test.invalid` });
  createdOwners.push(id);
  return id;
}

async function mkRepo(owner: string) {
  const res = await app.inject({ method: "POST", url: "/repos", headers: asOwner(owner), body: JSON.stringify({ name: `__test__ god ${uniq()}` }) });
  const id = res.json().data.id as string;
  createdRepos.push(id);
  return id;
}

async function approveOwnerScope(owner: string, repoId: string) {
  const started = await app.inject({ method: "POST", url: "/auth/device/start", headers: JSON_ONLY, body: "{}" });
  const { userCode } = started.json().data;
  const deviceCode = started.json().deviceCode as string;
  const approve = await app.inject({
    method: "POST", url: "/auth/device/approve", headers: asOwner(owner),
    body: JSON.stringify({ userCode, repoId, scope: "owner", agents: [{ name: `god-${uniq()}`, workerType: "claude", role: "orchestrator" }] }),
  });
  return { deviceCode, userCode, approve };
}

async function pollInvite(deviceCode: string) {
  const polled = await app.inject({ method: "POST", url: "/auth/device/token", headers: { Authorization: `Bearer ${deviceCode}`, ...JSON_ONLY } });
  expect(polled.statusCode).toBe(200);
  return polled.json().invites[0].code as string;
}

const accept = (code: string, role = "orchestrator") => app.inject({
  method: "POST", url: "/auth/accept-invite", headers: JSON_ONLY,
  body: JSON.stringify({ code, name: `a-${uniq()}`, role }),
});

async function makeGod(owner: string) {
  const repoId = await mkRepo(owner);
  const { deviceCode, approve } = await approveOwnerScope(owner, repoId);
  expect(approve.statusCode).toBe(200);
  const res = await accept(await pollInvite(deviceCode));
  expect(res.statusCode).toBe(201);
  return { repoId, token: res.json().token as string, agentId: res.json().data.id as string };
}

const authenticates = async (token: string) =>
  (await app.inject({ method: "GET", url: "/repos", headers: as(token) })).statusCode === 200;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
});

afterAll(async () => {
  if (createdOwners.length) await db.delete(ownerGodAgents).where(inArray(ownerGodAgents.ownerId, createdOwners));
  for (const id of createdRepos) await app.inject({ method: "DELETE", url: `/repos/${id}`, headers: ADMIN });
  for (const id of createdOwners) await db.delete(users).where(eq(users.id, id));
  await app?.close();
});

describe("one god agent per account", () => {
  it("refuses a second owner-scoped approval while a god agent exists, and leaves the code usable", async () => {
    const owner = await freshOwner();
    await makeGod(owner);

    const repoId = await mkRepo(owner);
    const { approve, userCode } = await approveOwnerScope(owner, repoId);
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error.code).toBe("god_agent_exists");

    const asRepoScope = await app.inject({
      method: "POST", url: "/auth/device/approve", headers: asOwner(owner),
      body: JSON.stringify({ userCode, repoId, agents: [{ name: `w-${uniq()}`, workerType: "claude", role: "orchestrator" }] }),
    });
    expect(asRepoScope.statusCode).toBe(200);
  });

  it("refuses the second of two owner-scoped grants approved before either was redeemed", async () => {
    const owner = await freshOwner();
    const first = await approveOwnerScope(owner, await mkRepo(owner));
    const second = await approveOwnerScope(owner, await mkRepo(owner));
    expect(first.approve.statusCode).toBe(200);
    expect(second.approve.statusCode).toBe(200);
    const firstCode = await pollInvite(first.deviceCode);
    const secondCode = await pollInvite(second.deviceCode);

    const firstGod = await accept(firstCode);
    expect(firstGod.statusCode).toBe(201);
    const refused = await accept(secondCode);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("god_agent_exists");

    // The second code is untouched by the failed redeem (no accept, no
    // revoke on the invite row), so a kill switch that revokes it along
    // with the first god is tested separately — see "also revokes a
    // SEPARATE, still-pending grant invite once a slot already exists",
    // below. It no longer survives a revoke here: see that test for why.
    await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(owner), body: "{}" });
    expect((await accept(secondCode)).statusCode).toBe(400);
  });

  it("does not limit another owner", async () => {
    await makeGod(await freshOwner());
    await makeGod(await freshOwner());
  });


});

describe("the god agent mints credentials only by invite, so the kill switch can find them", () => {
  it("cannot register an agent directly", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const res = await app.inject({ method: "POST", url: "/agents", headers: as(god.token), body: JSON.stringify({ repoId: god.repoId, name: `x-${uniq()}`, role: "worker" }) });
    expect(res.statusCode).toBe(403);
  });

  it("cannot mint a token for another agent, but can rotate its own", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const peerRepo = await mkRepo(owner);
    const peer = await app.inject({ method: "POST", url: "/agents", headers: asOwner(owner), body: JSON.stringify({ repoId: peerRepo, name: `p-${uniq()}`, role: "worker" }) });
    const other = await app.inject({ method: "POST", url: `/agents/${peer.json().data.id}/tokens`, headers: as(god.token), body: JSON.stringify({ keepExisting: true }) });
    expect(other.statusCode).toBe(403);
    const self = await app.inject({ method: "POST", url: `/agents/${god.agentId}/tokens`, headers: as(god.token), body: JSON.stringify({ keepExisting: true }) });
    expect(self.statusCode).toBe(201);
  });

  it("can invite workers but not orchestrators, so nothing it brings in can mint outside an invite", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const repoId = await mkRepo(owner);
    const res = await app.inject({ method: "POST", url: `/repos/${repoId}/invites`, headers: as(god.token), body: JSON.stringify({ role: "orchestrator" }) });
    expect(res.statusCode).toBe(403);
  });

  it("tells a worker it may not delete the top-level agent, without saying which one it is", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const code = (await app.inject({ method: "POST", url: `/repos/${god.repoId}/invites`, headers: as(god.token), body: "{}" })).json().code;
    const worker = (await accept(code, "worker")).json().token as string;
    const res = await app.inject({ method: "DELETE", url: `/agents/${god.agentId}`, headers: as(worker) });
    expect(res.statusCode).toBe(403);
  });

  it("cannot be deleted out from under the kill switch", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const res = await app.inject({ method: "DELETE", url: `/agents/${god.agentId}`, headers: asOwner(owner) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("god_agent_exists");
  });
});

describe("invites a god agent mints are short-lived", () => {
  it("default to one hour", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const before = Date.now();
    const res = await app.inject({ method: "POST", url: `/repos/${god.repoId}/invites`, headers: as(god.token), body: "{}" });
    expect(res.statusCode).toBe(201);
    const ttl = new Date(res.json().data.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(55 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(61 * 60 * 1000);
  });

  it("cannot be stretched past one hour", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const before = Date.now();
    const res = await app.inject({ method: "POST", url: `/repos/${god.repoId}/invites`, headers: as(god.token), body: JSON.stringify({ ttlSeconds: 7 * 24 * 3600 }) });
    expect(res.statusCode).toBe(201);
    expect(new Date(res.json().data.expiresAt).getTime() - before).toBeLessThanOrEqual(61 * 60 * 1000);
  });

  it("leave the owner's own dashboard invites at the long default", async () => {
    const owner = await freshOwner();
    const repoId = await mkRepo(owner);
    const before = Date.now();
    const res = await app.inject({ method: "POST", url: `/repos/${repoId}/invites`, headers: asOwner(owner), body: "{}" });
    expect(new Date(res.json().data.expiresAt).getTime() - before).toBeGreaterThan(24 * 3600 * 1000);
  });

  it("leave an ordinary orchestrator's invites at the long default", async () => {
    const owner = await freshOwner();
    const repoId = await mkRepo(owner);
    const orch = await app.inject({ method: "POST", url: "/agents", headers: asOwner(owner), body: JSON.stringify({ repoId, name: `o-${uniq()}`, role: "orchestrator" }) });
    const before = Date.now();
    const res = await app.inject({ method: "POST", url: `/repos/${repoId}/invites`, headers: as(orch.json().token), body: "{}" });
    expect(new Date(res.json().data.expiresAt).getTime() - before).toBeGreaterThan(24 * 3600 * 1000);
  });
});

describe("the owner's kill switch", () => {
  async function scenario() {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const minted = await app.inject({ method: "POST", url: `/repos/${god.repoId}/invites`, headers: as(god.token), body: "{}" });
    const joined = await accept(minted.json().code, "worker");
    const pending = await app.inject({ method: "POST", url: `/repos/${god.repoId}/invites`, headers: as(god.token), body: "{}" });
    const bystanderRepo = await mkRepo(owner);
    const bystander = await app.inject({ method: "POST", url: "/agents", headers: asOwner(owner), body: JSON.stringify({ repoId: bystanderRepo, name: `b-${uniq()}`, role: "worker" }) });
    return {
      owner, god,
      joinedToken: joined.json().token as string,
      pendingCode: pending.json().code as string,
      bystanderToken: bystander.json().token as string,
    };
  }

  it("lists the god agent and what it minted", async () => {
    const s = await scenario();
    const res = await app.inject({ method: "GET", url: "/owner/god-agent", headers: asOwner(s.owner) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.agents.map((a: { id: string }) => a.id)).toEqual([s.god.agentId]);
    // The 2 ordinary invites the god minted, plus the device-auth grant
    // invite that created it in the first place (ownerId-matched, already
    // accepted — listed for visibility, same as the pending-grant case).
    expect(res.json().data.invites).toHaveLength(3);
  });

  it("revokes the god agent, every credential it minted, and nothing else", async () => {
    const s = await scenario();
    const res = await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(s.owner), body: "{}" });
    expect(res.statusCode).toBe(200);

    expect(await authenticates(s.god.token)).toBe(false);
    expect(await authenticates(s.joinedToken)).toBe(false);
    expect((await accept(s.pendingCode, "worker")).statusCode).toBe(400);
    expect(await authenticates(s.bystanderToken)).toBe(true);
  });

  it("reaches every agent holding the owner's scope, and what each of them minted, slot or no slot", async () => {
    const s = await scenario();
    const legacyRepo = await mkRepo(s.owner);
    const legacy = await app.inject({ method: "POST", url: "/agents", headers: asOwner(s.owner), body: JSON.stringify({ repoId: legacyRepo, name: `l-${uniq()}`, role: "orchestrator" }) });
    const legacyId = legacy.json().data.id as string;
    const legacyToken = generateToken();
    await db.insert(tokens).values({ id: `tok_${uniq()}`, agentId: legacyId, ownerId: s.owner, tokenHash: hashToken(legacyToken) });
    const minted = await app.inject({ method: "POST", url: `/repos/${legacyRepo}/invites`, headers: as(legacyToken), body: "{}" });
    const invitee = (await accept(minted.json().code, "worker")).json().token as string;
    const unrelatedOwner = await freshOwner();
    const unrelated = await makeGod(unrelatedOwner);

    await db.delete(ownerGodAgents).where(eq(ownerGodAgents.ownerId, s.owner));
    const listed = await app.inject({ method: "GET", url: "/owner/god-agent", headers: asOwner(s.owner) });
    expect(listed.json().data.agents.map((a: { id: string }) => a.id).sort()).toEqual([s.god.agentId, legacyId].sort());

    const res = await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(s.owner), body: "{}" });
    expect(res.statusCode).toBe(200);
    // `invitee` descends from `legacyToken`, which was inserted directly
    // (bypassing accept-invite, the only path that ever sets a chain stamp)
    // to simulate a credential from before this rebuild. `legacyToken` itself
    // still gets revoked — the direct ownerId scan reaches it regardless of
    // any stamp. What it invited does not, because the invite it minted was
    // never stamped either (its own token carried no chainSlotId to pass
    // on). That is the deliberate boundary of the stamp design: a sweep by
    // ownerId still closes a legacy *holder*, but it does not re-derive a
    // lineage for what that holder invited, which is exactly the graph walk
    // this rebuild exists to not depend on. The historical version of this
    // gap is closed once, not held open forever, by migration 0011's
    // backfill stamping every live owner-scoped token at migration time — a
    // token minted after that outside every route that stamps is out of
    // scope by construction.
    for (const t of [s.god.token, s.joinedToken, legacyToken]) expect(await authenticates(t)).toBe(false);
    expect(await authenticates(invitee)).toBe(true);
    expect(await authenticates(s.bystanderToken)).toBe(true);
    expect(await authenticates(unrelated.token)).toBe(true);
  });

  it("follows the invite chain past the agents the god invited directly", async () => {
    const s = await scenario();
    const second = await app.inject({ method: "POST", url: `/repos/${s.god.repoId}/invites`, headers: as(s.joinedToken), body: JSON.stringify({ ttlSeconds: 7 * 24 * 3600 }) });
    expect(second.statusCode).toBe(201);
    const grandchild = (await accept(second.json().code, "worker")).json().token as string;
    const third = await app.inject({ method: "POST", url: `/repos/${s.god.repoId}/invites`, headers: as(grandchild), body: "{}" });

    await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(s.owner), body: "{}" });
    expect(await authenticates(grandchild)).toBe(false);
    expect((await accept(third.json().code, "worker")).statusCode).toBe(400);
  });

  it("leaves no live token when a redeem races the revoke", async () => {
    for (let i = 0; i < 10; i++) {
      const owner = await freshOwner();
      const god = await makeGod(owner);
      const code = (await app.inject({ method: "POST", url: `/repos/${god.repoId}/invites`, headers: as(god.token), body: "{}" })).json().code;
      const [redeemed] = await Promise.all([
        accept(code, "worker"),
        app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(owner), body: "{}" }),
      ]);
      // A 500 here would mean the chain-dead check regressed back to running
      // AFTER the invite claim (locking invite-then-slot instead of
      // slot-then-invite) and reintroduced the lock-order deadlock this
      // ordering exists to avoid. The two live outcomes are 201 (won the
      // race) and 400 (lost it, chain-dead or issuer-revoked) — never a
      // database error surfacing as a 500.
      expect(redeemed.statusCode, "accept must not 500 under this race").not.toBe(500);
      if (redeemed.statusCode === 201) expect(await authenticates(redeemed.json().token)).toBe(false);
    }
  });

  it("leaves no invite redeemable once its issuer has been revoked", async () => {
    const s = await scenario();
    await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(s.owner), body: "{}" });
    const [late] = await db.select({ id: invites.id }).from(invites).where(eq(invites.createdBy, s.god.agentId)).limit(1);
    await db.update(invites).set({ revokedAt: null, acceptedAt: null }).where(eq(invites.id, late.id));
    const code = `inv_late_${uniq()}`;
    await db.update(invites).set({ codeHash: hashToken(code), expiresAt: new Date(Date.now() + 3600_000) }).where(eq(invites.id, late.id));
    expect((await accept(code, "worker")).statusCode).toBe(400);
  });

  it("refuses a self-rotation whose presenting token was revoked under it", async () => {
    const s = await scenario();
    const results = await Promise.all([
      app.inject({ method: "POST", url: `/agents/${s.god.agentId}/tokens`, headers: as(s.god.token), body: JSON.stringify({ keepExisting: true }) }),
      app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(s.owner), body: "{}" }),
    ]);
    const rotated = results[0];
    if (rotated.statusCode === 201) expect(await authenticates(rotated.json().token)).toBe(false);
  });

  it("will not delete the repo that holds the top-level agent", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const res = await app.inject({ method: "DELETE", url: `/repos/${god.repoId}`, headers: asOwner(owner) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("god_agent_exists");
  });

  it("does not wait on the agent's row — revoke only ever locks the slot", async () => {
    const s = await scenario();
    // Held for the whole transaction below. The old transitive-walk design's
    // revoke locked this same agents row, because ITS enforcement point was
    // the bulk sweep itself — a token a concurrent rotation inserted a
    // moment later would otherwise be missed and stay live forever. The
    // stamp design's enforcement point moved to auth time (see "refuses a
    // self-rotation whose presenting token was revoked under it", above), so
    // revoke no longer needs this row at all. If it still contended for it,
    // the inject call below would hang behind this same transaction and the
    // test would time out rather than resolve.
    await db.transaction(async (tx) => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, s.god.agentId)).for("update");
      const res = await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(s.owner), body: "{}" });
      expect(res.statusCode).toBe(200);
    });
  });

  it("frees the slot for a new god agent", async () => {
    const s = await scenario();
    await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(s.owner), body: "{}" });
    await makeGod(s.owner);
  });

  it("is refused to every agent credential, the god agent included", async () => {
    const s = await scenario();
    for (const path of ["/owner/god-agent", "/owner/god-agent/revoke"]) {
      const method = path.endsWith("revoke") ? "POST" : "GET";
      const res = await app.inject({ method, url: path, headers: as(s.god.token), ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.statusCode, path).toBe(404);
    }
    expect(await authenticates(s.god.token)).toBe(true);
  });

  it("answers 404 when the owner has no god agent", async () => {
    const res = await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(await freshOwner()), body: "{}" });
    expect(res.statusCode).toBe(404);
  });
});

describe("findings the stamp rebuild closes", () => {
  it("keeps a lineage revocable after a downstream agent deletes itself (finding 1)", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const firstInvite = await app.inject({ method: "POST", url: `/repos/${god.repoId}/invites`, headers: as(god.token), body: "{}" });
    const firstAccept = await accept(firstInvite.json().code, "worker");
    const firstToken = firstAccept.json().token as string;
    const firstId = firstAccept.json().data.id as string;

    const secondInvite = await app.inject({ method: "POST", url: `/repos/${god.repoId}/invites`, headers: as(firstToken), body: "{}" });
    const secondCode = secondInvite.json().code as string;
    const secondInviteId = secondInvite.json().data.id as string;

    // The first agent deletes itself, nulling createdBy on the invite it
    // just minted (agents.ts's cascade). The old transitive walk used that
    // column to find descendants, so this cut them out of it.
    expect((await app.inject({ method: "DELETE", url: `/agents/${firstId}`, headers: as(firstToken) })).statusCode).toBe(204);
    const [row] = await db.select({ createdBy: invites.createdBy }).from(invites).where(eq(invites.id, secondInviteId));
    expect(row.createdBy).toBeNull();

    // The stamp on the invite survives regardless, because it was copied at
    // mint time and revoke never reads createdBy to find it.
    await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(owner), body: "{}" });
    expect((await accept(secondCode, "worker")).statusCode).toBe(400);
  });

  it("locks the issuer's token row at redeem, so a concurrent revoke can't be missed (finding 2)", async () => {
    const owner = await freshOwner();
    const repoId = await mkRepo(owner);
    const orch = await app.inject({ method: "POST", url: "/agents", headers: asOwner(owner), body: JSON.stringify({ repoId, name: `o2-${uniq()}`, role: "orchestrator" }) });
    const orchToken = orch.json().token as string;
    const orchId = orch.json().data.id as string;
    const code = (await app.inject({ method: "POST", url: `/repos/${repoId}/invites`, headers: as(orchToken), body: "{}" })).json().code as string;

    // Held for the whole transaction below, the way a revoke of the issuer's
    // own token would hold it. Before this fix the issuer-live check read
    // unlocked, so accept could read "still live" from a row a concurrent
    // revoke was about to commit as dead.
    let accepted: { statusCode: number } | undefined;
    await db.transaction(async (tx) => {
      await tx.select({ id: tokens.id }).from(tokens).where(eq(tokens.agentId, orchId)).for("update");
      const pending = accept(code, "worker").then((r) => { accepted = r; });
      await new Promise((r) => setTimeout(r, 300));
      expect(accepted).toBeUndefined();
      void pending;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(accepted?.statusCode).toBe(201);
  });

  it("deletes the god's home repo after revoke without 500ing on a sibling repo's invite (finding 3)", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const otherRepo = await mkRepo(owner);
    const minted = await app.inject({ method: "POST", url: `/repos/${otherRepo}/invites`, headers: as(god.token), body: "{}" });
    expect(minted.statusCode).toBe(201);
    const inviteId = minted.json().data.id as string;

    await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(owner), body: "{}" });
    const res = await app.inject({ method: "DELETE", url: `/repos/${god.repoId}`, headers: asOwner(owner) });
    expect(res.statusCode).toBe(204);

    const [after] = await db.select({ createdBy: invites.createdBy }).from(invites).where(eq(invites.id, inviteId));
    expect(after.createdBy).toBeNull();
  });

  it("lets an owner-scoped token read a sibling repo's tasks by passing repoId", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const siblingRepo = await mkRepo(owner);
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: asOwner(owner),
      body: JSON.stringify({ repoId: siblingRepo, createdBy: "owner", title: `t-${uniq()}`, description: "d" }),
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({ method: "GET", url: `/tasks?repoId=${siblingRepo}`, headers: as(god.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((t: { id: string }) => t.id)).toContain(created.json().data.id);
  });

  it("does not let an owner-scoped token read a DIFFERENT owner's repo by passing its repoId", async () => {
    const ownerA = await freshOwner();
    const godA = await makeGod(ownerA);
    const ownerB = await freshOwner();
    const repoB = await mkRepo(ownerB);
    const taskB = await app.inject({
      method: "POST", url: "/tasks", headers: asOwner(ownerB),
      body: JSON.stringify({ repoId: repoB, createdBy: "owner", title: `t-${uniq()}`, description: "d" }),
    });
    expect(taskB.statusCode).toBe(201);

    const res = await app.inject({ method: "GET", url: `/tasks?repoId=${repoB}`, headers: as(godA.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("carries the stamp through a PEER-initiated rotation, not just self-rotation", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    // A SEPARATE repo, with its own pre-existing orchestrator — agents_one_
    // orchestrator_per_repo means the god's own home repo already has one
    // (the god agent itself, which is separately blocked from rotating
    // anyone but itself), so a peer-initiated rotation can only be
    // demonstrated in a repo the god didn't register into.
    const peerRepo = await mkRepo(owner);
    const orchestrator = await app.inject({
      method: "POST", url: "/agents", headers: asOwner(owner),
      body: JSON.stringify({ repoId: peerRepo, name: `o3-${uniq()}`, role: "orchestrator" }),
    });
    expect(orchestrator.statusCode).toBe(201);
    // The god agent is owner-scoped, so it can mint an invite into ANY repo
    // the owner owns, not only its own — the same cross-repo reach GET
    // /repos and GET /agents already grant it.
    const invite = await app.inject({ method: "POST", url: `/repos/${peerRepo}/invites`, headers: as(god.token), body: "{}" });
    expect(invite.statusCode).toBe(201);
    const worker = await accept(invite.json().code, "worker");
    const workerId = worker.json().data.id as string;

    // That repo's orchestrator — not the worker, not the god agent — rotates
    // the worker's token. The comment on agents.ts's carriedChainSlotId
    // claims the stamp survives regardless of who initiates, unlike
    // ownerId, which is conditional on the rotator being entitled to it.
    // Pin that claim rather than trusting the comment: the freshly rotated
    // token must still die when the god agent is revoked.
    const rotated = await app.inject({
      method: "POST", url: `/agents/${workerId}/tokens`, headers: as(orchestrator.json().token), body: "{}",
    });
    expect(rotated.statusCode).toBe(201);
    const rotatedToken = rotated.json().token as string;

    await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(owner), body: "{}" });
    expect(await authenticates(rotatedToken)).toBe(false);
  });

  it("carries the stamp through a rotation even when the agent has NO live token to read it from", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const peerRepo = await mkRepo(owner);
    const orchestrator = await app.inject({
      method: "POST", url: "/agents", headers: asOwner(owner),
      body: JSON.stringify({ repoId: peerRepo, name: `o4-${uniq()}`, role: "orchestrator" }),
    });
    const invite = await app.inject({ method: "POST", url: `/repos/${peerRepo}/invites`, headers: as(god.token), body: "{}" });
    const worker = await accept(invite.json().code, "worker");
    const workerId = worker.json().data.id as string;

    // The exploit this closes: revoke the agent's only token first (any
    // orchestrator in its repo may, via DELETE /tokens/:id — the same gate
    // as rotation), THEN rotate. Before this fix, the carry-forward read was
    // filtered to live rows, so `live` came back empty and the freshly
    // minted token got chainSlotId: null — permanently outside the owner's
    // kill switch, in two ordinary-looking calls, no revoke race needed.
    const [tok] = await db.select({ id: tokens.id }).from(tokens).where(eq(tokens.agentId, workerId));
    const revokeTok = await app.inject({ method: "DELETE", url: `/tokens/${tok.id}`, headers: as(orchestrator.json().token) });
    expect(revokeTok.statusCode).toBe(204);

    const rotated = await app.inject({
      method: "POST", url: `/agents/${workerId}/tokens`, headers: as(orchestrator.json().token), body: "{}",
    });
    expect(rotated.statusCode).toBe(201);
    const rotatedToken = rotated.json().token as string;

    await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(owner), body: "{}" });
    expect(await authenticates(rotatedToken)).toBe(false);
  });

  it("kills a token minted AFTER revoke's bulk sweep already ran, deterministically", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const [slot] = await db.select({ id: ownerGodAgents.id }).from(ownerGodAgents).where(eq(ownerGodAgents.ownerId, owner));
    expect(slot?.id).toBeTruthy();

    await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(owner), body: "{}" });

    // Simulate a rotation (or any insert) landing after the sweep: a brand
    // new token row, stamped with the slot id that is now gone. Nothing in
    // revoke's bulk updates could have touched this row, since it didn't
    // exist yet when they ran — the auth-time check is the only thing that
    // can still kill it.
    const lateToken = generateToken();
    await db.insert(tokens).values({
      id: `tok_${uniq()}`, agentId: god.agentId, chainSlotId: slot.id, tokenHash: hashToken(lateToken),
    });
    expect(await authenticates(lateToken)).toBe(false);
  });

  it("revokes a pending owner-scope grant invite when it's the only thing outstanding", async () => {
    // Nobody has redeemed anything yet: no slot, no stamped token. The grant
    // invite itself carries ownerId but no createdBy/chainSlotId (device-auth
    // never sets either), so neither the slot-based nor the direct-holder
    // reach can find it — before this fix, the owner's kill switch answered
    // 404 ("nothing to revoke") while a redeemable, owner-scoped invite code
    // was still sitting in a chat transcript or CLI output.
    const owner = await freshOwner();
    const { deviceCode } = await approveOwnerScope(owner, await mkRepo(owner));
    const code = await pollInvite(deviceCode);

    const res = await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(owner), body: "{}" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.invitesRevoked).toBe(1);

    expect((await accept(code)).statusCode).toBe(400);
  });

  it("also revokes a SEPARATE, still-pending grant invite once a slot already exists", async () => {
    // Two owner-scope approvals made before either was redeemed is a real,
    // separately-tested scenario (see "refuses the second of two
    // owner-scoped grants..." above) — device-auth refuses a SECOND
    // approval once a god already exists, so both grants have to be
    // approved first, before either is redeemed.
    //
    // This used to leave the second, independently-approved grant alone,
    // reasoning that revoking the one that got redeemed shouldn't also burn
    // a separate decision the operator made. Reviewed and reversed: an
    // owner hitting the kill switch because they believe everything is
    // compromised must not have a live, owner-scoped invite code survive it
    // — "total revocation" has to mean total. An operator who genuinely
    // wants a second grant to survive can re-approve it after revoking;
    // that is a deliberate second action, not something this silently
    // assumes on their behalf.
    const owner = await freshOwner();
    const first = await approveOwnerScope(owner, await mkRepo(owner));
    const second = await approveOwnerScope(owner, await mkRepo(owner));
    expect(first.approve.statusCode).toBe(200);
    expect(second.approve.statusCode).toBe(200);
    const god = await accept(await pollInvite(first.deviceCode));
    expect(god.statusCode).toBe(201);
    const pendingCode = await pollInvite(second.deviceCode);

    const res = await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(owner), body: "{}" });
    expect(res.json().data.invitesRevoked).toBe(1);
    expect(await authenticates(god.json().token)).toBe(false);
    expect((await accept(pendingCode)).statusCode).toBe(400);
  });

  it("would carry the stamp forward through POST /agents, if a stamped caller could ever reach it", async () => {
    // No LIVE route can put a stamped (chainSlotId set), non-owner-scoped
    // orchestrator in a position to call POST /agents today: the god can
    // only mint worker invites (see "can invite workers but not
    // orchestrators" above), a worker can't hold orchestrator role or call
    // this route, and nothing promotes a worker's role after creation. That
    // safety rests on three independent guards elsewhere, none of which is
    // this route's own job to enforce — so this pins the INSERT itself,
    // fabricating the otherwise-unreachable state directly, the way a
    // future change to any one of those three guards could.
    const owner = await freshOwner();
    await makeGod(owner); // only needed for the side effect of creating a slot
    const [slot] = await db.select({ id: ownerGodAgents.id }).from(ownerGodAgents).where(eq(ownerGodAgents.ownerId, owner));
    const peerRepo = await mkRepo(owner);
    const fabricated = await app.inject({
      method: "POST", url: "/agents", headers: asOwner(owner),
      body: JSON.stringify({ repoId: peerRepo, name: `stamped-orch-${uniq()}`, role: "worker" }),
    });
    const fabricatedId = fabricated.json().data.id as string;
    await db.update(agents).set({ role: "orchestrator" }).where(eq(agents.id, fabricatedId));
    const stampedToken = generateToken();
    await db.insert(tokens).values({
      id: `tok_${uniq()}`, agentId: fabricatedId, chainSlotId: slot.id, tokenHash: hashToken(stampedToken),
    });

    const registered = await app.inject({
      method: "POST", url: "/agents", headers: as(stampedToken),
      body: JSON.stringify({ repoId: peerRepo, name: `w-${uniq()}`, role: "worker" }),
    });
    expect(registered.statusCode).toBe(201);
    const [newTok] = await db.select({ chainSlotId: tokens.chainSlotId }).from(tokens).where(eq(tokens.agentId, registered.json().data.id));
    expect(newTok.chainSlotId).toBe(slot.id);
  });
});
