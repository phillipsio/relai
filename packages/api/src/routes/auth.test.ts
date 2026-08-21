import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import { createDb, agents, tokens } from "@getrelai/db";
import { eq } from "drizzle-orm";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-auth";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}` };

let app: FastifyInstance;
let repoId: string;
let agentId: string;
let plaintextToken: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/repos",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "__test__ auth" }),
  });
  expect(project.statusCode).toBe(201);
  repoId = project.json().data.id;

  const agent = await app.inject({
    method: "POST", url: "/agents",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ repoId, name: "auth-test-agent", role: "worker" }),
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().data.id;
  plaintextToken = agent.json().token;
  expect(plaintextToken).toMatch(/^aio_/);
});

afterAll(async () => {
  if (repoId) {
    await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  }
  await app?.close();
});

describe("auth: per-agent tokens", () => {
  it("accepts a valid agent token and resolves request.agent", async () => {
    const res = await app.inject({
      method: "GET", url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${plaintextToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(agentId);
  });

  it("rejects a syntactically valid but unknown token", async () => {
    const res = await app.inject({
      method: "GET", url: "/agents",
      headers: { Authorization: "Bearer aio_unknownnonsense" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("still accepts the legacy API_SECRET (fallback)", async () => {
    const res = await app.inject({ method: "GET", url: "/agents", headers: ADMIN });
    expect(res.statusCode).toBe(200);
  });

  it("rejects requests with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/agents" });
    expect(res.statusCode).toBe(401);
  });
});

describe("auth: service-admin token + X-Owner-Id", () => {
  const SERVICE_TOKEN = "test-service-admin-token";

  it("rejects service-admin auth without X-Owner-Id", async () => {
    process.env.SERVICE_ADMIN_TOKEN = SERVICE_TOKEN;
    const res = await app.inject({
      method: "GET", url: "/repos",
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("owner_required");
  });

  it("rejects malformed X-Owner-Id", async () => {
    const res = await app.inject({
      method: "GET", url: "/repos",
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "X-Owner-Id": "not-a-user-id" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("owner_required");
  });

  it("accepts service-admin with a usr_ X-Owner-Id and scopes results", async () => {
    const res = await app.inject({
      method: "GET", url: "/repos",
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "X-Owner-Id": "usr_nonexistent" },
    });
    // Auth passes (200), and scope filter returns no projects for the unknown user.
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("falls back to API_SECRET when SERVICE_ADMIN_TOKEN does not match", async () => {
    const res = await app.inject({
      method: "GET", url: "/repos",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("auth: token rotate + revoke", () => {
  let secondToken: string;
  let secondTokenId: string;

  it("POST /agents/:id/tokens issues an additional token", async () => {
    const res = await app.inject({
      method: "POST", url: `/agents/${agentId}/tokens`,
      headers: { ...ADMIN, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(201);
    secondToken = res.json().token;
    secondTokenId = res.json().data.id;
    expect(secondToken).toMatch(/^aio_/);
    expect(secondToken).not.toBe(plaintextToken);
  });

  it("the new token authenticates", async () => {
    const res = await app.inject({
      method: "GET", url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${secondToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("DELETE /tokens/:id revokes a token", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/tokens/${secondTokenId}`,
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(204);
  });

  it("a revoked token is rejected", async () => {
    const res = await app.inject({
      method: "GET", url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${secondToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("the original token still works after sibling revoke", async () => {
    const res = await app.inject({
      method: "GET", url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${plaintextToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("shared-secret comparison", () => {
  it("accepts the configured secret and rejects a wrong one", async () => {
    const ok = await app.inject({ method: "GET", url: "/health", headers: { Authorization: `Bearer ${SECRET}` } });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({ method: "GET", url: "/health", headers: { Authorization: "Bearer not-the-secret" } });
    expect(bad.statusCode).toBe(401);
  });

  // A naive timingSafeEqual throws on differing buffer lengths, which would turn
  // a wrong password into a 500. Hashing both sides first is what avoids that.
  it("rejects secrets of the wrong length cleanly rather than erroring", async () => {
    for (const attempt of ["x", "", SECRET + "extra", "z".repeat(500)]) {
      const res = await app.inject({ method: "GET", url: "/health", headers: { Authorization: `Bearer ${attempt}` } });
      expect(res.statusCode).toBe(401);
    }
  });
});

// agents.lastSeenAt is what the routing scheduler's online filter and the
// list_agents `online` flag both read, so an agent that drives the API without
// sending explicit heartbeats must still register as awake.
describe("authenticating stamps activity", () => {
  const db = createDb(DB_URL);
  const stamps = async () => {
    const [a] = await db.select({ seen: agents.lastSeenAt }).from(agents).where(eq(agents.id, agentId));
    const rows = await db.select({ used: tokens.lastUsedAt }).from(tokens).where(eq(tokens.agentId, agentId));
    return { seen: a.seen?.getTime() ?? 0, used: Math.max(0, ...rows.map((r) => r.used?.getTime() ?? 0)) };
  };

  // The writes are deliberately not awaited by the request, so poll rather than
  // assume they have landed by the time the response returns.
  const settled = async (predicate: (s: { seen: number; used: number }) => boolean) => {
    for (let i = 0; i < 40; i++) {
      const s = await stamps();
      if (predicate(s)) return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    return stamps();
  };

  it("moves lastSeenAt and lastUsedAt on an ordinary authenticated request", async () => {
    await db.update(agents).set({ lastSeenAt: new Date(0) }).where(eq(agents.id, agentId));
    await db.update(tokens).set({ lastUsedAt: null }).where(eq(tokens.agentId, agentId));

    const before = Date.now();
    const res = await app.inject({ method: "GET", url: "/health", headers: { Authorization: `Bearer ${plaintextToken}` } });
    expect(res.statusCode).toBe(200);

    const after = await settled((s) => s.seen >= before && s.used >= before);
    expect(after.seen).toBeGreaterThanOrEqual(before);
    expect(after.used).toBeGreaterThanOrEqual(before);
  });

  // The scheduler reads a 10-minute window, so writing the row on every single
  // request would be pure amplification: two writes per call, on the hot path.
  // Uses its own agent because the throttle is keyed in memory by agent id, and
  // the tests above have already stamped the shared one.
  it("does not rewrite the stamp again inside the throttle interval", async () => {
    const reg = await app.inject({
      method: "POST", url: "/agents",
      headers: { ...ADMIN, "Content-Type": "application/json" },
      body: JSON.stringify({ repoId, name: "throttle-agent", role: "worker" }),
    });
    const id = reg.json().data.id as string;
    const hdr = { Authorization: `Bearer ${reg.json().token}` };
    const seenOf = async () =>
      (await db.select({ v: agents.lastSeenAt }).from(agents).where(eq(agents.id, id)))[0].v?.getTime() ?? 0;

    const prev = process.env.AUTH_STAMP_INTERVAL_MS;
    process.env.AUTH_STAMP_INTERVAL_MS = "60000";
    try {
      await app.inject({ method: "GET", url: "/health", headers: hdr });
      const first = await seenOf();
      expect(first).toBeGreaterThan(0);

      await new Promise((r) => setTimeout(r, 50));
      await app.inject({ method: "GET", url: "/health", headers: hdr });
      expect(await seenOf()).toBe(first);
    } finally {
      process.env.AUTH_STAMP_INTERVAL_MS = prev;
    }
  });

  it("does not stamp when the token is rejected", async () => {
    await db.update(agents).set({ lastSeenAt: new Date(0) }).where(eq(agents.id, agentId));

    const res = await app.inject({ method: "GET", url: "/health", headers: { Authorization: "Bearer aio_not_a_real_token" } });
    expect(res.statusCode).toBe(401);

    await new Promise((r) => setTimeout(r, 200));
    expect((await stamps()).seen).toBe(0);
  });
});
