import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { buildServer } from "../server.js";
import { deliver } from "../lib/notifications.js";
import { createDb, notificationChannels, users, repos } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppEvent } from "../lib/events.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-notif";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

let app: FastifyInstance;
let repoId: string;
let agentAId: string;
let agentBId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ notif" }),
  });
  repoId = project.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "notif-a", role: "worker" }),
  });
  agentAId = a.json().data.id;

  const b = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "notif-b", role: "worker" }),
  });
  agentBId = b.json().data.id;
});

afterAll(async () => {
  if (repoId) {
    await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
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

  it("POST creates a slack channel with webhookUrl config", async () => {
    const res = await app.inject({
      method: "POST", url: "/notification-channels", headers: ADMIN,
      body: JSON.stringify({
        agentId: agentAId,
        kind: "slack",
        config: { webhookUrl: "https://hooks.slack.test/services/T/B/X" },
      }),
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.kind).toBe("slack");
    expect(data.config.webhookUrl).toBe("https://hooks.slack.test/services/T/B/X");
    await app.inject({ method: "DELETE", url: `/notification-channels/${data.id}`, headers: ADMIN });
  });

  it("rejects a slack channel with a webhook-shaped config (url instead of webhookUrl)", async () => {
    const res = await app.inject({
      method: "POST", url: "/notification-channels", headers: ADMIN,
      body: JSON.stringify({ agentId: agentAId, kind: "slack", config: { url: "https://example.test/hook" } }),
    });
    expect(res.statusCode).toBe(400);
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
      body: JSON.stringify({ repoId, title: "delivery thread" }),
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
    repoId,
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

describe("slack delivery", () => {
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
        kind: "slack",
        config: { webhookUrl: "https://hooks.slack.test/services/T/B/X" },
      }),
    });
    channelId = ch.json().data.id;

    const t = await app.inject({
      method: "POST", url: "/threads", headers: ADMIN,
      body: JSON.stringify({ repoId, title: "slack delivery thread" }),
    });
    threadId = t.json().data.id;

    await app.inject({
      method: "POST", url: "/subscriptions", headers: ADMIN,
      body: JSON.stringify({ agentId: agentBId, targetType: "thread", targetId: threadId }),
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const db = createDb(DB_URL);
    await db.delete(notificationChannels).where(eq(notificationChannels.id, channelId));
  });

  it("posts a formatted { text } summary to the Slack webhook URL, no HMAC headers", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const db = createDb(DB_URL);

    const escalationEvent: AppEvent = {
      id: "evt_test_slack_1",
      kind: "message.posted",
      repoId,
      targetType: "thread",
      targetId: threadId,
      payload: { message: { type: "escalation", body: "need a decision", fromAgent: "agent_orch" } },
      createdAt: new Date().toISOString(),
    };

    await deliver(db, escalationEvent, { retries: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.slack.test/services/T/B/X");

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Relai-Signature"]).toBeUndefined();
    expect(headers["X-Relai-Timestamp"]).toBeUndefined();

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain("🚨 Escalation");
    expect(body.text).toContain("need a decision");
    expect(body.text).toContain("agent_orch");
  });

  it("formats a task event with title/priority/status", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const db = createDb(DB_URL);

    // targetType/targetId match the thread subscription set up in beforeEach
    // (resolveSubscribers needs a hit) — only the kind/payload shape matters
    // for what's under test here, which is the Slack text formatting.
    const taskEvent: AppEvent = {
      id: "evt_test_slack_2",
      kind: "task.updated",
      repoId,
      targetType: "thread",
      targetId: threadId,
      payload: { task: { title: "Fix the thing", priority: "urgent", status: "blocked" } },
      createdAt: new Date().toISOString(),
    };

    await deliver(db, taskEvent, { retries: 0 });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain("Fix the thing");
    expect(body.text).toContain("urgent");
    expect(body.text).toContain("blocked");
  });

  it("reuses the same retry/circuit-breaker logic as webhook channels", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const db = createDb(DB_URL);
    const event: AppEvent = {
      id: "evt_test_slack_3", kind: "message.posted", repoId, targetType: "thread", targetId: threadId,
      payload: { message: { type: "status", body: "x", fromAgent: "a" } }, createdAt: new Date().toISOString(),
    };

    for (let i = 0; i < 5; i++) await deliver(db, event, { retries: 0 });

    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    expect(row.failureCount).toBe(5);
    expect(row.disabledAt).not.toBeNull();
  });
});

describe("owner-scoped notification channels", () => {
  const fetchMock = vi.fn();
  let originalFetch: typeof fetch;
  const db = createDb(DB_URL);
  let ownerId: string;
  let ownedRepoId: string;
  let ownerChannelId: string;

  beforeAll(async () => {
    ownerId = `usr_ownernotif_${Date.now()}`;
    await db.insert(users).values({ id: ownerId, email: `${ownerId}@test.example` });
    const r = await app.inject({
      method: "POST", url: "/repos", headers: ADMIN,
      body: JSON.stringify({ name: "__test__ owned notif" }),
    });
    ownedRepoId = r.json().data.id;
    await db.update(repos).set({ ownerId }).where(eq(repos.id, ownedRepoId));
  });

  afterAll(async () => {
    // Delete the repo via the route first (clears its agents + agent channels,
    // which FK the repo), then the user (cascades the owned repo's ownership
    // and any owner-scoped channels).
    await app.inject({ method: "DELETE", url: `/repos/${ownedRepoId}`, headers: ADMIN });
    await db.delete(users).where(eq(users.id, ownerId));
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const attentionEvent = (repoIdArg: string, kind: AppEvent["kind"] = "task.blocked"): AppEvent => ({
    id: "evt_owner_1", kind, repoId: repoIdArg, targetType: "task", targetId: "task_x",
    payload: { task: { title: "t", status: "blocked", priority: "normal" } }, createdAt: new Date().toISOString(),
  });

  it("POST with an explicit ownerId creates an owner-scoped channel (no agentId)", async () => {
    const res = await app.inject({
      method: "POST", url: "/notification-channels", headers: ADMIN,
      body: JSON.stringify({ ownerId, kind: "webhook", config: { url: "https://owner.test/hook" } }),
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.id).toMatch(/^nch_/);
    expect(data.agentId).toBeNull();
    expect(data.ownerId).toBe(ownerId);
    ownerChannelId = data.id;
  });

  it("POST 404s for an unknown owner", async () => {
    const res = await app.inject({
      method: "POST", url: "/notification-channels", headers: ADMIN,
      body: JSON.stringify({ ownerId: "usr_nope", kind: "webhook", config: { url: "https://x.test/h" } }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("a per-agent caller cannot create an owner channel (no privilege escalation)", async () => {
    // Register an agent and use ITS token: passing someone's ownerId must not
    // create an owner-scoped channel — it falls back to a self-scoped agent
    // channel instead.
    const reg = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId: ownedRepoId, name: "escalation-probe", role: "worker" }),
    });
    const token = reg.json().token as string;
    const res = await app.inject({
      method: "POST", url: "/notification-channels",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId, kind: "webhook", config: { url: "https://evil.test/hook" } }),
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.ownerId).toBeNull();
    expect(data.agentId).toBe(reg.json().data.id);
  });

  it("fires on an attention-transition event for the owner's repo — no subscription needed", async () => {
    await deliver(db, attentionEvent(ownedRepoId, "task.blocked"), { retries: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://owner.test/hook");
  });

  // Asserting the set itself, not three examples: the bug this fixes was
  // task.proposed_overdue never being added, which per-kind tests cannot catch.
  it("pins exactly which kinds count as needing a human", async () => {
    const { OWNER_ATTENTION_KINDS } = await import("../lib/notifications.js");
    expect([...OWNER_ATTENTION_KINDS].sort()).toEqual([
      "task.blocked",
      "task.blocked_overdue",
      "task.pending_verification",
      "task.proposed",
      "task.proposed_overdue",
      "task.review_overdue",
    ]);
  });

  it("fires on the overdue nudges, which is what a stalled proposal produces", async () => {
    await deliver(db, attentionEvent(ownedRepoId, "task.proposed_overdue"), { retries: 0 });
    await deliver(db, attentionEvent(ownedRepoId, "task.review_overdue"), { retries: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fires on task.pending_verification and task.proposed too", async () => {
    await deliver(db, attentionEvent(ownedRepoId, "task.pending_verification"), { retries: 0 });
    await deliver(db, attentionEvent(ownedRepoId, "task.proposed"), { retries: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT fire on a non-attention event (e.g. task.updated / message.posted)", async () => {
    await deliver(db, attentionEvent(ownedRepoId, "task.updated"), { retries: 0 });
    await deliver(db, { ...attentionEvent(ownedRepoId), kind: "message.posted", targetType: "thread", targetId: "thread_x" }, { retries: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT fire for an attention event on a repo the owner does not own", async () => {
    await deliver(db, attentionEvent(repoId, "task.blocked"), { retries: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
