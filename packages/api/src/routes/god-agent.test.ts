import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, users } from "@getrelai/db";
import { eq } from "drizzle-orm";
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

    await app.inject({ method: "DELETE", url: `/agents/${firstGod.json().data.id}`, headers: asOwner(owner) });
    expect((await accept(secondCode)).statusCode).toBe(201);
  });

  it("does not limit another owner", async () => {
    await makeGod(await freshOwner());
    await makeGod(await freshOwner());
  });

  it("frees the slot when the god agent is deleted", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const del = await app.inject({ method: "DELETE", url: `/agents/${god.agentId}`, headers: asOwner(owner) });
    expect(del.statusCode).toBeLessThan(300);
    await makeGod(owner);
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
    expect(res.json().data.agent.id).toBe(s.god.agentId);
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
