import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Only the address check is stubbed, so fetch stays real and this observes
// undici's actual redirect behaviour. A mocked fetch could only show that
// redirect:"manual" was passed, which stays green if the runtime changes.
// It also has to be stubbed: any redirector reachable from a test runs on
// loopback, which the address check refuses first, and correctly so.
vi.mock("./outbound-url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./outbound-url.js")>()),
  resolvesToBlockedAddress: async () => false,
}));

import { buildServer } from "../server.js";
import { deliver } from "./notifications.js";
import { createDb, notificationChannels } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { AppEvent } from "./events.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-redirect";
process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;
const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

const db = createDb(DB_URL);
let app: FastifyInstance;
let repoId: string, agentId: string, threadId: string, channelId: string;
let redirector: Server, target: Server, redirectorUrl: string;
let targetHits = 0;

beforeAll(async () => {
  const http = await import("node:http");
  target = http.createServer((_q, r) => { targetHits++; r.writeHead(200); r.end("SHOULD NOT BE REACHED"); });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const tPort = (target.address() as AddressInfo).port;

  redirector = http.createServer((_q, r) => {
    r.writeHead(302, { location: `http://127.0.0.1:${tPort}/latest/meta-data/` });
    r.end();
  });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  redirectorUrl = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/hook`;

  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  repoId = (await app.inject({ method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ redirect" }) })).json().data.id;
  agentId = (await app.inject({ method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "rd-agent", role: "worker" }) })).json().data.id;
  threadId = (await app.inject({ method: "POST", url: "/threads", headers: ADMIN,
    body: JSON.stringify({ repoId, title: "rd thread" }) })).json().data.id;
  await app.inject({ method: "POST", url: "/subscriptions", headers: ADMIN,
    body: JSON.stringify({ agentId, targetType: "thread", targetId: threadId }) });

  channelId = `nch_redirect_${Date.now()}`;
  await db.insert(notificationChannels).values({
    id: channelId, agentId, kind: "webhook",
    config: { url: redirectorUrl }, secret: "whsec_test",
  });
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
  await new Promise<void>((r) => redirector.close(() => r()));
  await new Promise<void>((r) => target.close(() => r()));
});

const event = (id: string): AppEvent => ({
  id, kind: "message.posted", repoId,
  targetType: "thread", targetId: threadId,
  payload: { hello: "world" }, createdAt: new Date().toISOString(),
});

describe("delivery does not follow redirects", () => {
  it("never reaches the redirect target, and records the refusal", async () => {
    targetHits = 0;
    await deliver(db, event("evt_rd_1"), { retries: 0 });
    expect(targetHits).toBe(0);
    const [after] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    expect(after.lastError ?? "").toMatch(/refusing to follow a 30\d redirect/);
  });

  it("does not retry it, and does not advance the circuit breaker", async () => {
    targetHits = 0;
    for (let i = 0; i < 3; i++) await deliver(db, event(`evt_rd_loop_${i}`), { retries: 2, baseDelayMs: 50 });
    expect(targetHits).toBe(0);
    const [after] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    expect(after.failureCount).toBe(0);
    expect(after.disabledAt).toBeNull();
  });
});
