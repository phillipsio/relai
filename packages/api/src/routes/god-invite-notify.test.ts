import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildServer } from "../server.js";
import { createDb, users, tokens, invites, agents, ownerGodAgents, subscriptions } from "@getrelai/db";
import { generateToken, hashToken } from "../lib/tokens.js";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { bus, resolveSubscribers, type AppEvent } from "../lib/events.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-god-invite-notify";
const SERVICE = "test-service-admin-god-invite-notify";

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


const KIND = "invite.minted_by_top_level";
let seen: AppEvent[] = [];
const capture = (e: AppEvent) => { seen.push(e); };

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
  bus.on("event", capture);
});

afterAll(async () => {
  bus.off("event", capture);
  if (createdOwners.length) await db.delete(ownerGodAgents).where(inArray(ownerGodAgents.ownerId, createdOwners));
  for (const id of createdRepos) await app.inject({ method: "DELETE", url: `/repos/${id}`, headers: ADMIN });
  for (const id of createdOwners) await db.delete(users).where(eq(users.id, id));
  await app?.close();
});

const mint = (repoId: string, headers: Record<string, string>) => app.inject({
  method: "POST", url: `/repos/${repoId}/invites`, headers, body: JSON.stringify({ role: "worker" }),
});
const mintedEvents = (inviteId: string) => seen.filter((e) => e.kind === KIND && e.payload.inviteId === inviteId);

describe("invite.minted_by_top_level", () => {
  it("fires for an invite the top-level agent mints, with no code in it", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const target = await mkRepo(owner);
    const res = await mint(target, as(god.token));
    expect(res.statusCode).toBe(201);

    const [event, ...rest] = mintedEvents(res.json().data.id);
    expect(rest).toHaveLength(0);
    expect(event.repoId).toBe(target);
    expect(event.actorId).toBe(god.agentId);
    expect(event.targetType).toBe("agent");
    expect(event.payload).toMatchObject({
      inviteId: res.json().data.id, repoId: target, role: "worker", expiresAt: res.json().data.expiresAt,
    });
    expect((event.payload.mintedBy as { agentId: string }).agentId).toBe(god.agentId);
    expect(typeof (event.payload.mintedBy as { name: unknown }).name).toBe("string");
    expect(typeof event.payload.repoName).toBe("string");
    expect(event.payload).not.toHaveProperty("chainSlotId");
    const raw = JSON.stringify(event);
    expect(raw).not.toContain(res.json().code);
    expect(raw).not.toContain("codeHash");
  });

  it("fires for an invite minted by an agent the top-level agent brought in", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const invited = await mint(god.repoId, as(god.token));
    const joined = await accept(invited.json().code, "worker");
    expect(joined.statusCode).toBe(201);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000 });
    try {
      const res = await mint(god.repoId, as(joined.json().token));
      expect(res.statusCode).toBe(201);
      expect(mintedEvents(res.json().data.id)).toHaveLength(1);
      expect(mintedEvents(res.json().data.id)[0].payload.mintedBy).toMatchObject({ agentId: joined.json().data.id });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends one notice per lineage per ten minutes", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const first = await mint(god.repoId, as(god.token));
    const second = await mint(god.repoId, as(god.token));
    expect(second.statusCode).toBe(201);
    expect(mintedEvents(first.json().data.id)).toHaveLength(1);
    expect(mintedEvents(second.json().data.id)).toHaveLength(0);
  });

  it("fires for an owner-scoped token that carries no lineage stamp", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    await db.update(tokens).set({ chainSlotId: null }).where(eq(tokens.agentId, god.agentId));
    const res = await mint(god.repoId, as(god.token));
    expect(res.statusCode).toBe(201);
    expect(mintedEvents(res.json().data.id)).toHaveLength(1);
  });

  it("reaches no agent subscriber, only owner channels", async () => {
    const owner = await freshOwner();
    const god = await makeGod(owner);
    const res = await mint(god.repoId, as(god.token));
    const seed = await mint(god.repoId, asOwner(owner));
    const peer = await accept(seed.json().code, "worker");
    await db.insert(subscriptions).values({ id: `sub_${uniq()}`, agentId: peer.json().data.id, targetType: "agent", targetId: god.agentId });
    const [event] = mintedEvents(res.json().data.id);
    expect(await resolveSubscribers(db, event)).toEqual([]);
  });

  it("does not fire for an invite the owner mints from the dashboard", async () => {
    const owner = await freshOwner();
    const repoId = await mkRepo(owner);
    const res = await mint(repoId, asOwner(owner));
    expect(res.statusCode).toBe(201);
    expect(mintedEvents(res.json().data.id)).toHaveLength(0);
  });

  it("does not fire for an invite an ordinary repo agent mints", async () => {
    const owner = await freshOwner();
    const repoId = await mkRepo(owner);
    const seed = await mint(repoId, asOwner(owner));
    const joined = await accept(seed.json().code, "worker");
    expect(joined.statusCode).toBe(201);

    const res = await mint(repoId, as(joined.json().token));
    expect(res.statusCode).toBe(201);
    expect(mintedEvents(res.json().data.id)).toHaveLength(0);
  });
});
