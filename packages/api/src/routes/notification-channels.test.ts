import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { buildServer } from "../server.js";
import { deliver } from "../lib/notifications.js";
import { createDb, notificationChannels } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppEvent } from "../lib/events.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-notif";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

let app: FastifyInstance;
let projectId: string;
let agentAId: string;
let agentBId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/projects", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ notif" }),
  });
  projectId = project.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ projectId, name: "notif-a", role: "worker" }),
  });
  agentAId = a.json().data.id;

  const b = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ projectId, name: "notif-b", role: "worker" }),
  });
  agentBId = b.json().data.id;
});

afterAll(async () => {
  if (projectId) {
    await app.inject({ method: "DELETE", url: `/projects/${projectId}`, headers: ADMIN });
  }
  await app?.close();
});

describe("notification-channels CRUD", () => {
  let channelId: string;

  it("POST creates a webhook channel for the caller's resolved agent", async () => {
    const res = await app.inject({
      method: "POST", url: "/notification-channels", headers: ADMIN,
      body: JSON.stringify({
        agentId: agentAId,
        kind: "webhook",
        config: { url: "https://example.test/hook", headers: { "X-Token": "abc" } },
      }),
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.id).toMatch(/^nch_/);
    expect(data.agentId).toBe(agentAId);
    expect(data.kind).toBe("webhook");
    expect(data.disabledAt).toBeNull();
    expect(data.failureCount).toBe(0);
    expect(data.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    channelId = data.id;
  });

  it("PUT regenerateSecret rotates the HMAC secret", async () => {
    const before = await app.inject({
      method: "GET", url: `/notification-channels?agentId=${agentAId}`, headers: ADMIN,
    });
    const original = (before.json().data as Array<{ id: string; secret: string }>).find((r) => r.id === channelId)!;

    const res = await app.inject({
      method: "PUT", url: `/notification-channels/${channelId}`, headers: ADMIN,
      body: JSON.stringify({ regenerateSecret: true }),
    });
    expect(res.statusCode).toBe(200);
    const rotated = res.json().data;
    expect(rotated.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(rotated.secret).not.toBe(original.secret);
  });

  it("rejects invalid URL", async () => {
    const res = await app.inject({
      method: "POST", url: "/notification-channels", headers: ADMIN,
      body: JSON.stringify({ agentId: agentAId, kind: "webhook", config: { url: "not-a-url" } }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET filters by agentId", async () => {
    const res = await app.inject({
      method: "GET", url: `/notification-channels?agentId=${agentAId}`, headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ agentId: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.agentId === agentAId)).toBe(true);
  });

  it("PUT updates config", async () => {
    const res = await app.inject({
      method: "PUT", url: `/notification-channels/${channelId}`, headers: ADMIN,
      body: JSON.stringify({ config: { url: "https://example.test/v2" } }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.config.url).toBe("https://example.test/v2");
  });

  it("PUT disabled:false clears trip state", async () => {
    const db = createDb(DB_URL);
    await db.update(notificationChannels)
      .set({ disabledAt: new Date(), failureCount: 9, lastError: "boom" })
      .where(eq(notificationChannels.id, channelId));

    const res = await app.inject({
      method: "PUT", url: `/notification-channels/${channelId}`, headers: ADMIN,
      body: JSON.stringify({ disabled: false }),
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().data;
    expect(row.disabledAt).toBeNull();
    expect(row.failureCount).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it("DELETE removes the channel", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/notification-channels/${channelId}`, headers: ADMIN,
    });
    expect(res.statusCode).toBe(204);
  });
});

describe("webhook delivery", () => {
  const fetchMock = vi.fn();
  let originalFetch: typeof fetch;
  let channelId: string;
  let threadId: string;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();

    const ch = await app.inject({
      method: "POST", url: "/notification-channels", headers: ADMIN,
      body: JSON.stringify({
        agentId: agentBId,
        kind: "webhook",
        config: { url: "https://example.test/hook" },
      }),
    });
    channelId = ch.json().data.id;

    const t = await app.inject({
      method: "POST", url: "/threads", headers: ADMIN,
      body: JSON.stringify({ projectId, title: "delivery thread" }),
    });
    threadId = t.json().data.id;

    const db = createDb(DB_URL);
    // Subscribe agentB to the thread so events resolve to them.
    await app.inject({
      method: "POST", url: "/subscriptions", headers: ADMIN,
      body: JSON.stringify({ agentId: agentBId, targetType: "thread", targetId: threadId }),
    });
    void db; // keep import-used for tests below
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const db = createDb(DB_URL);
    await db.delete(notificationChannels).where(eq(notificationChannels.id, channelId));
  });

  const event = (): AppEvent => ({
    id:         "evt_test_1",
    kind:       "message.posted",
    projectId,
    targetType: "thread",
    targetId:   threadId,
    payload:    { hello: "world" },
    createdAt:  new Date().toISOString(),
  });

  it("POSTs to subscribed agent's webhook on event", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const db = createDb(DB_URL);

    await deliver(db, event(), { retries: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/hook");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.kind).toBe("message.posted");
    expect(body.targetId).toBe(threadId);

    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    expect(row.lastDeliveredAt).not.toBeNull();
    expect(row.failureCount).toBe(0);
  });

  it("signs the request with HMAC-SHA256 over `${timestamp}.${body}`", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const db = createDb(DB_URL);

    await deliver(db, event(), { retries: 0 });

    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    const body    = (init as RequestInit).body    as string;

    expect(headers["X-Relai-Timestamp"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(headers["X-Relai-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    const expected = createHmac("sha256", row.secret!).update(`${headers["X-Relai-Timestamp"]}.${body}`).digest("hex");
    expect(headers["X-Relai-Signature"]).toBe(`sha256=${expected}`);
  });

  it("lazy-generates a secret for legacy channels with secret=null", async () => {
    const db = createDb(DB_URL);
    await db.update(notificationChannels)
      .set({ secret: null })
      .where(eq(notificationChannels.id, channelId));

    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await deliver(db, event(), { retries: 0 });

    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    expect(row.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
  });

  it("retries on 5xx with exponential backoff (then counts as one failure)", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(new Response("err", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok",  { status: 200 }));
    const db = createDb(DB_URL);

    await deliver(db, event(), { retries: 2, baseDelayMs: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    expect(row.failureCount).toBe(0);
    expect(row.lastDeliveredAt).not.toBeNull();
  });

  it("retries on 429 (rate limit)", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("slow", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok",   { status: 200 }));
    const db = createDb(DB_URL);

    await deliver(db, event(), { retries: 2, baseDelayMs: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx other than 429", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const db = createDb(DB_URL);

    await deliver(db, event(), { retries: 2, baseDelayMs: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    expect(row.failureCount).toBe(1);
    expect(row.lastError).toContain("404");
  });

  it("retries on network errors", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const db = createDb(DB_URL);

    await deliver(db, event(), { retries: 2, baseDelayMs: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records failure and increments failureCount on non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const db = createDb(DB_URL);

    await deliver(db, event(), { retries: 0 });

    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    expect(row.failureCount).toBe(1);
    expect(row.lastError).toContain("500");
    expect(row.disabledAt).toBeNull();
  });

  it("trips circuit breaker after 5 consecutive failures", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const db = createDb(DB_URL);

    for (let i = 0; i < 5; i++) await deliver(db, event(), { retries: 0 });

    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    expect(row.failureCount).toBe(5);
    expect(row.disabledAt).not.toBeNull();
  });

  it("disabled channels do not receive deliveries", async () => {
    const db = createDb(DB_URL);
    await db.update(notificationChannels)
      .set({ disabledAt: new Date() })
      .where(eq(notificationChannels.id, channelId));

    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await deliver(db, event(), { retries: 0 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("success after a failure clears failureCount and lastError", async () => {
    const db = createDb(DB_URL);
    await db.update(notificationChannels)
      .set({ failureCount: 3, lastError: "old" })
      .where(eq(notificationChannels.id, channelId));

    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await deliver(db, event(), { retries: 0 });

    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    expect(row.failureCount).toBe(0);
    expect(row.lastError).toBeNull();
  });
});
