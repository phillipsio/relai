import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { bus, resolveSubscribers, type AppEvent } from "../lib/events.js";
import { createDb, subscriptions } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-events";

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
    body: JSON.stringify({ name: "__test__ events" }),
  });
  projectId = project.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ projectId, name: "agent-a", role: "worker" }),
  });
  agentAId = a.json().data.id;

  const b = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ projectId, name: "agent-b", role: "worker" }),
  });
  agentBId = b.json().data.id;
});

afterAll(async () => {
  if (projectId) {
    await app.inject({ method: "DELETE", url: `/projects/${projectId}`, headers: ADMIN });
  }
  await app?.close();
});

describe("subscriptions CRUD", () => {
  let subId: string;

  it("POST /subscriptions creates a subscription", async () => {
    const res = await app.inject({
      method: "POST", url: "/subscriptions", headers: ADMIN,
      body: JSON.stringify({ agentId: agentAId, targetType: "agent", targetId: agentBId }),
    });
    expect(res.statusCode).toBe(201);
    subId = res.json().data.id;
    expect(subId).toMatch(/^sub_/);
  });

  it("POST is idempotent — same target returns 200 with existing row", async () => {
    const res = await app.inject({
      method: "POST", url: "/subscriptions", headers: ADMIN,
      body: JSON.stringify({ agentId: agentAId, targetType: "agent", targetId: agentBId }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(subId);
  });

  it("GET /subscriptions filters by agentId", async () => {
    const res = await app.inject({ method: "GET", url: `/subscriptions?agentId=${agentAId}`, headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ agentId: string }>;
    expect(data.every((s) => s.agentId === agentAId)).toBe(true);
  });

  it("DELETE removes a subscription", async () => {
    const res = await app.inject({ method: "DELETE", url: `/subscriptions/${subId}`, headers: ADMIN });
    expect(res.statusCode).toBe(204);
  });
});

describe("auto-subscribe + publish on message post", () => {
  let threadId: string;

  beforeAll(async () => {
    const t = await app.inject({
      method: "POST", url: "/threads", headers: ADMIN,
      body: JSON.stringify({ projectId, title: "events-test thread" }),
    });
    threadId = t.json().data.id;
  });

  it("posting a message subscribes sender and recipient to the thread", async () => {
    await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: ADMIN,
      body: JSON.stringify({ fromAgent: agentAId, toAgent: agentBId, type: "handoff", body: "hi" }),
    });

    const db = createDb(DB_URL);
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.targetId, threadId));
    const agentIds = subs.map((s) => s.agentId);
    expect(agentIds).toContain(agentAId);
    expect(agentIds).toContain(agentBId);
  });

  it("emits a message.posted event that resolves to the recipient's subscriptions", async () => {
    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);

    await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: ADMIN,
      body: JSON.stringify({ fromAgent: agentAId, toAgent: agentBId, type: "status", body: "still here" }),
    });

    bus.off("event", handler);
    const messageEvents = events.filter((e) => e.kind === "message.posted" && e.targetId === threadId);
    expect(messageEvents.length).toBeGreaterThanOrEqual(1);

    const db = createDb(DB_URL);
    const subscribers = await resolveSubscribers(db, messageEvents[0]);
    expect(subscribers).toContain(agentAId);
    expect(subscribers).toContain(agentBId);
  });
});

describe("auto-subscribe + publish on task create/update", () => {
  it("emits task.created and subscribes the creator", async () => {
    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);

    const res = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        projectId, createdBy: agentAId,
        title: "Event-test task", description: "test",
      }),
    });
    bus.off("event", handler);
    const taskId = res.json().data.id;

    const created = events.find((e) => e.kind === "task.created" && e.targetId === taskId);
    expect(created).toBeDefined();

    const db = createDb(DB_URL);
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.targetId, taskId));
    expect(subs.some((s) => s.agentId === agentAId)).toBe(true);
  });

  it("emits task.updated on PUT /tasks/:id", async () => {
    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({ projectId, createdBy: agentAId, title: "x", description: "y" }),
    });
    const taskId = create.json().data.id;

    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);

    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
      body: JSON.stringify({ status: "in_progress", assignedTo: agentBId }),
    });
    bus.off("event", handler);

    const updated = events.find((e) => e.kind === "task.updated" && e.targetId === taskId);
    expect(updated).toBeDefined();
    expect(updated!.alsoNotify?.[0]?.targetId).toBe(agentBId);
  });
});

describe("GET /events stream", () => {
  it("rejects callers without a per-agent token (legacy API_SECRET)", async () => {
    const res = await app.inject({ method: "GET", url: "/events", headers: ADMIN });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });
});
