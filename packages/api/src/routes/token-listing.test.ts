// An operator cannot audit what they cannot enumerate.
//
// 21 live tokens across 19 agents accumulated in production before anyone
// noticed (task_o6BhrRbJndRhyMdvnctAy), and the reason nobody noticed is that
// no route listed them: the pile was only ever visible by opening Postgres on
// the box. GET /agents/:id/tokens closes that, under the same gate as rotating
// and revoking, so it hands out no authority those two do not already carry.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, tokens } from "@getrelai/db";
import { eq, and, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-token-listing";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
let repoId: string;
let otherRepoId: string;
const db = createDb(DB_URL);

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const r = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ token-listing" }),
  });
  repoId = r.json().data.id;

  const o = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ token-listing other" }),
  });
  otherRepoId = o.json().data.id;
});

afterAll(async () => {
  for (const id of [repoId, otherRepoId]) {
    if (id) await app.inject({ method: "DELETE", url: `/repos/${id}`, headers: ADMIN });
  }
  await app?.close();
});

let seq = 0;
const mk = async (role: "orchestrator" | "worker" = "worker", inRepo = repoId) => {
  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId: inRepo, name: `tl-${role}-${++seq}`, role }),
  });
  return { id: a.json().data.id as string, token: a.json().token as string };
};

const list = (agentId: string, headers: Record<string, string>) =>
  app.inject({ method: "GET", url: `/agents/${agentId}/tokens`, headers });

const rotate = (agentId: string, headers: Record<string, string>) =>
  app.inject({ method: "POST", url: `/agents/${agentId}/tokens`, headers, body: JSON.stringify({}) });

describe("an agent can enumerate its own credentials", () => {
  it("returns the one it was registered with", async () => {
    const a = await mk();
    const res = await list(a.id, as(a.token));
    expect(res.statusCode).toBe(200);

    const rows = res.json().data as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].id).toMatch(/^tok_/);
    expect(rows[0].revokedAt).toBeNull();
    expect(rows[0]).toHaveProperty("createdAt");
    expect(rows[0]).toHaveProperty("lastUsedAt");
  });

  it("shows a revoked predecessor alongside the live one, which is the whole point", async () => {
    const a = await mk();
    const first = (await db.select().from(tokens).where(eq(tokens.agentId, a.id)))[0].id;

    const rot = await rotate(a.id, as(a.token));
    expect(rot.statusCode).toBe(201);
    const fresh = rot.json().token as string;

    const rows = (await list(a.id, as(fresh))).json().data as Array<Record<string, string | null>>;
    expect(rows.length).toBe(2);

    const retired = rows.find((r) => r.id === first);
    expect(retired?.revokedAt).not.toBeNull();
    expect(rows.filter((r) => r.revokedAt === null).length).toBe(1);
  });
});

describe("the caller can tell which row it is holding", () => {
  // A client minted at registration or invite acceptance never saw its token
  // id, so without this marker revoking from the list is a coin flip.
  it("marks exactly the token that authenticated the request", async () => {
    const a = await mk();
    const rot = await rotate(a.id, as(a.token));
    const fresh = rot.json().token as string;
    const freshId = rot.json().data.id as string;

    const rows = (await list(a.id, as(fresh))).json().data as Array<{ id: string; current: boolean }>;
    expect(rows.filter((r) => r.current).length).toBe(1);
    expect(rows.find((r) => r.current)?.id).toBe(freshId);
  });

  it("marks nothing when an orchestrator reads someone else's list", async () => {
    const orch = await mk("orchestrator");
    const worker = await mk();

    const rows = (await list(worker.id, as(orch.token))).json().data as Array<{ current: boolean }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.current === false)).toBe(true);
  });
});

describe("a caller that cannot be told apart says so", () => {
  it("reports current as null on the shared-secret path, never false", async () => {
    const a = await mk();
    const rows = (await list(a.id, ADMIN)).json().data as Array<{ current: boolean | null }>;
    expect(rows.length).toBe(1);
    // false would read as "not the one you are holding" and invite an operator
    // to revoke the agent's only credential.
    expect(rows[0].current).toBeNull();
  });
});

describe("lastUsedAt is per token, not per agent", () => {
  // The audit is only as good as this column. The activity stamp used to be
  // throttled on the agent id, so when one token kept the window warm its
  // sibling was never stamped however often it authenticated, and the CLI
  // reported an actively-used credential as never used and told the operator to
  // revoke it. That is the audit giving the inverted answer.
  it("stamps a second live token that is doing the authenticating", async () => {
    const a = await mk();
    const second = await app.inject({
      method: "POST", url: `/agents/${a.id}/tokens`, headers: as(a.token),
      body: JSON.stringify({ keepExisting: true }),
    });
    expect(second.statusCode).toBe(201);
    const secondToken = second.json().token as string;
    const secondId = second.json().data.id as string;

    // The suite pins AUTH_STAMP_INTERVAL_MS=0, which disables the very throttle
    // this is about, so turn it back on for the two calls that matter.
    const prev = process.env.AUTH_STAMP_INTERVAL_MS;
    process.env.AUTH_STAMP_INTERVAL_MS = "60000";
    try {
      // The first token warms the window, then the second authenticates.
      expect((await app.inject({ method: "GET", url: "/health", headers: as(a.token) })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/health", headers: as(secondToken) })).statusCode).toBe(200);
    } finally {
      // Assigning an undefined prev writes the literal "undefined", whose
      // Number() is NaN, which disables every stamp for the rest of the worker.
      if (prev === undefined) delete process.env.AUTH_STAMP_INTERVAL_MS;
      else process.env.AUTH_STAMP_INTERVAL_MS = prev;
    }

    const rows = (await list(a.id, as(a.token))).json().data as Array<{ id: string; lastUsedAt: string | null }>;
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.id === secondId)?.lastUsedAt).not.toBeNull();
    expect(rows.every((r) => r.lastUsedAt !== null)).toBe(true);
  });
});

describe("the listing carries no secret material", () => {
  it("omits tokenHash, the one column that must never leave the server", async () => {
    const a = await mk();
    const res = await list(a.id, as(a.token));

    const stored = (await db
      .select()
      .from(tokens)
      .where(and(eq(tokens.agentId, a.id), isNull(tokens.revokedAt))))[0].tokenHash;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);

    expect(res.body).not.toContain(stored);
    expect(res.json().data[0]).not.toHaveProperty("tokenHash");
  });
});

describe("the gate is the one rotation and revocation already use", () => {
  it("lets an orchestrator read a worker's tokens in its own repo", async () => {
    const orch = await mk("orchestrator");
    const worker = await mk();

    const res = await list(worker.id, as(orch.token));
    expect(res.statusCode).toBe(200);
    expect((res.json().data as unknown[]).length).toBe(1);
  });

  it("refuses a peer worker in the same repo", async () => {
    const mine = await mk();
    const peer = await mk();

    const res = await list(mine.id, as(peer.token));
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("tok_");
  });

  it("404s across tenants rather than admitting the agent exists", async () => {
    const mine = await mk();
    const stranger = await mk("orchestrator", otherRepoId);

    const res = await list(mine.id, as(stranger.token));
    expect(res.statusCode).toBe(404);
  });
});
