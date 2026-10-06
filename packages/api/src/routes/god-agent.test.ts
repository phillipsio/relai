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

  it("refuses the second of two owner-scoped grants approved before either was redeemed, and keeps its code redeemable", async () => {
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

    await app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(owner), body: "{}" });
    expect((await accept(secondCode)).statusCode).toBe(201);
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
    expect(res.json().data.invites).toHaveLength(2);
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
    for (const t of [s.god.token, s.joinedToken, legacyToken, invitee]) expect(await authenticates(t)).toBe(false);
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

  it("waits for a rotation holding the agent's row, so it cannot miss the token that rotation inserts", async () => {
    const s = await scenario();
    let revoked = false;
    await db.transaction(async (tx) => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, s.god.agentId)).for("update");
      const pending = app.inject({ method: "POST", url: "/owner/god-agent/revoke", headers: asOwner(s.owner), body: "{}" })
        .then(() => { revoked = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(revoked).toBe(false);
      void pending;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(revoked).toBe(true);
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
