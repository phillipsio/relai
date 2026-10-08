import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { publish } from "../lib/events.js";
import { createDb, tokens, subscriptions, ownerGodAgents } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-sse-revoke";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;
process.env.SSE_HEARTBEAT_MS = "200";

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const db = createDb(DB_URL);
let app: FastifyInstance;
let base: string;
let repoId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const repo = await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name: "__test__ sse revoke" }) });
  repoId = repo.json().data.id;
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

async function agentWithStream() {
  const res = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role: "worker" }),
  });
  const agentId = res.json().data.id as string;
  const token = res.json().token as string;
  const stream = await fetch(`${base}/events`, { headers: { Authorization: `Bearer ${token}` } });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const readUntilClosed = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
      ]);
      if (next === null) return { closed: false, text };
      if (next.done) return { closed: true, text };
      text += decoder.decode(next.value);
    }
    return { closed: false, text };
  };
  return { agentId, token, reader, readUntilClosed };
}

const threadEvent = (threadId: string) => ({
  id: `evt_sse_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  kind: "message.posted" as const,
  repoId,
  targetType: "thread" as const,
  targetId: threadId,
  payload: {},
  createdAt: new Date().toISOString(),
});

describe("GET /events ends when its credential dies", () => {
  it("delivers to a live token", async () => {
    const s = await agentWithStream();
    const threadId = `thread_sse_${Date.now()}`;
    await db.insert(subscriptions).values({ id: `sub_${Date.now()}`, agentId: s.agentId, targetType: "thread", targetId: threadId });
    const event = threadEvent(threadId);
    await publish(db, event);
    const out = await s.readUntilClosed(600);
    expect(out.text).toContain(event.id);
    expect(out.closed).toBe(false);
    await s.reader.cancel();
  });

  it("closes without delivering once the token is revoked", async () => {
    const s = await agentWithStream();
    const threadId = `thread_sse_${Date.now()}`;
    await db.insert(subscriptions).values({ id: `sub_${Date.now()}`, agentId: s.agentId, targetType: "thread", targetId: threadId });
    await db.update(tokens).set({ revokedAt: new Date() }).where(eq(tokens.agentId, s.agentId));
    const event = threadEvent(threadId);
    await publish(db, event);
    const out = await s.readUntilClosed(2000);
    expect(out.text).not.toContain(event.id);
    expect(out.closed).toBe(true);
  });

  it("closes on the next heartbeat when no event arrives", async () => {
    const s = await agentWithStream();
    await db.update(tokens).set({ revokedAt: new Date() }).where(eq(tokens.agentId, s.agentId));
    const out = await s.readUntilClosed(2000);
    expect(out.closed).toBe(true);
  });

  it("closes once the token's lineage slot is deleted", async () => {
    const s = await agentWithStream();
    const ownerId = `usr_sse_${Date.now()}`;
    const { users } = await import("@getrelai/db");
    await db.insert(users).values({ id: ownerId, email: `${ownerId}@test.invalid` });
    const [slot] = await db.insert(ownerGodAgents).values({ id: `slot_${Date.now()}`, ownerId, agentId: s.agentId }).returning();
    await db.update(tokens).set({ chainSlotId: slot.id }).where(eq(tokens.agentId, s.agentId));
    await s.reader.cancel();

    const relogged = await fetch(`${base}/events`, { headers: { Authorization: `Bearer ${s.token}` } });
    expect(relogged.status).toBe(200);
    const reader = relogged.body!.getReader();
    await db.delete(ownerGodAgents).where(eq(ownerGodAgents.id, slot.id));
    const done = await Promise.race([
      (async () => { for (;;) { const r = await reader.read(); if (r.done) return true; } })(),
      new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
    ]);
    expect(done).toBe(true);
    await db.delete(users).where(eq(users.id, ownerId));
  });
});
