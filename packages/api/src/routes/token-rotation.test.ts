// "Rotate" has to retire what it replaces, or it is not a rotation.
//
// POST /agents/:id/tokens was a bare INSERT: it returned a new plaintext and
// left every earlier token live, so the operation everyone reached for after a
// leak added a credential rather than replacing one. Measured across the fleet
// in task_o6BhrRbJndRhyMdvnctAy.
//
// Revoking here grants no authority: every caller callerMayActOnAgent admits
// may already revoke the same agent's tokens via DELETE /tokens/:id. The last
// describe pins that equivalence, because without it this is a privilege hole.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, tokens } from "@getrelai/db";
import { eq, and, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-token-rotation";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
let repoId: string;
const db = createDb(DB_URL);

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const r = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ token-rotation" }),
  });
  repoId = r.json().data.id;
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

let seq = 0;
const mk = async (role: "orchestrator" | "worker" = "worker") => {
  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: `tr-${role}-${++seq}`, role }),
  });
  return { id: a.json().data.id as string, token: a.json().token as string };
};

const liveTokens = (agentId: string) =>
  db.select().from(tokens).where(and(eq(tokens.agentId, agentId), isNull(tokens.revokedAt)));

const allTokens = (agentId: string) =>
  db.select().from(tokens).where(eq(tokens.agentId, agentId));

// The only honest test of "is this credential dead": use it.
const healthAs = (t: string) => app.inject({ method: "GET", url: "/health", headers: as(t) });

const rotate = (agentId: string, headers: Record<string, string>, body?: unknown) =>
  app.inject({
    method: "POST", url: `/agents/${agentId}/tokens`, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("rotation retires the credential it replaces", () => {
  it("leaves exactly one live token, and it is the new one", async () => {
    const a = await mk();
    expect((await liveTokens(a.id)).length).toBe(1);

    const res = await rotate(a.id, as(a.token));
    expect(res.statusCode).toBe(201);
    const fresh = res.json().token as string;

    const live = await liveTokens(a.id);
    expect(live.length).toBe(1);
    expect(live[0].id).toBe(res.json().data.id);

    // Both directions matter. A test that only checked the new one works would
    // pass against the old bare-INSERT code.
    expect((await healthAs(fresh)).statusCode).toBe(200);
    expect((await healthAs(a.token)).statusCode).toBe(401);
  });

  it("revokes rather than deletes, so the audit trail survives", async () => {
    const a = await mk();
    await rotate(a.id, as(a.token));

    const rows = await allTokens(a.id);
    expect(rows.length).toBe(2);
    const revoked = rows.filter((r) => r.revokedAt !== null);
    expect(revoked.length).toBe(1);
    expect(revoked[0].revokedAt).toBeInstanceOf(Date);
  });

  it("reports which tokens it retired, since nothing else can list them", async () => {
    const a = await mk();
    const firstRotate = await rotate(a.id, as(a.token));
    const second = firstRotate.json().token as string;

    const res = await rotate(a.id, as(second));
    const revoked = res.json().revoked as string[];
    expect(revoked).toEqual([firstRotate.json().data.id]);
  });

  it("collapses an existing pile in one call, not one call per token", async () => {
    // The state production was actually in: several live tokens on one agent,
    // accumulated by earlier rotations that never revoked.
    const a = await mk();
    const extra: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await rotate(a.id, as(a.token), { keepExisting: true });
      extra.push(r.json().token as string);
    }
    expect((await liveTokens(a.id)).length).toBe(4);

    const res = await rotate(a.id, as(a.token));
    expect((res.json().revoked as string[]).length).toBe(4);
    expect((await liveTokens(a.id)).length).toBe(1);

    // Every one of the old credentials is dead, not just the most recent.
    for (const t of [a.token, ...extra]) {
      expect((await healthAs(t)).statusCode).toBe(401);
    }
  });

  it("is idempotent in effect: rotating twice still leaves one live token", async () => {
    const a = await mk();
    const r1 = await rotate(a.id, as(a.token));
    const r2 = await rotate(a.id, as(r1.json().token));
    expect((r2.json().revoked as string[])).toEqual([r1.json().data.id]);
    expect((await liveTokens(a.id)).length).toBe(1);
  });
});

describe("concurrent rotations still converge on one live token", () => {
  // The expectation to avoid, because it is the one anyone writes first and I
  // wrote it myself: that both rotations return 201. They cannot. The loser is
  // authenticating with a credential the winner just revoked, so 401 is correct.
  //
  // What this pins is the invariant, not the lock. On a fast local Postgres the
  // timing would likely come out right without the SELECT ... FOR UPDATE in the
  // handler, so read a pass as "nobody has broken the invariant" rather than as
  // evidence the race is closed. The lock is the argument; this is the alarm.
  it("two rotations fired together leave one live token, not two", async () => {
    const a = await mk();
    const results = await Promise.all([
      rotate(a.id, as(a.token)),
      rotate(a.id, as(a.token)),
    ]);

    // The loser legitimately gets 401: the winner retired the very token it was
    // authenticating with. Which one wins is a race, so the status is asserted
    // as a set rather than per-request, but at least one must have succeeded.
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.every((c) => c === 201 || c === 401)).toBe(true);
    expect(codes).toContain(201);

    expect((await liveTokens(a.id)).length).toBe(1);
    expect((await healthAs(a.token)).statusCode).toBe(401);
  });
});

describe("keepExisting opts out, for a migration that needs two live credentials", () => {
  it("keeps the old token alive and reports nothing revoked", async () => {
    const a = await mk();
    const res = await rotate(a.id, as(a.token), { keepExisting: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().revoked).toEqual([]);

    expect((await liveTokens(a.id)).length).toBe(2);
    expect((await healthAs(a.token)).statusCode).toBe(200);
    expect((await healthAs(res.json().token)).statusCode).toBe(200);
  });

  it("defaults to revoking when the flag is absent, an empty body, or false", async () => {
    // A default that only holds when a body is supplied would leave every
    // existing caller, none of which send one, on the old behaviour.
    for (const body of [undefined, {}, { keepExisting: false }]) {
      const a = await mk();
      await rotate(a.id, as(a.token), body);
      expect((await liveTokens(a.id)).length).toBe(1);
      expect((await healthAs(a.token)).statusCode).toBe(401);
    }
  });

  // A misspelling silently ran the DESTRUCTIVE default: zod strips unknown keys,
  // so a wrong type was refused but a wrong name was not. That lands on exactly
  // the operator the flag exists for, mid-migration, killing the other machine's
  // credential. device-auth.ts uses .strict() on its own schema for this reason.
  it("refuses a misspelled flag rather than silently revoking", async () => {
    for (const body of [{ keepexisting: true }, { keep_existing: true }, { keepExsiting: true }]) {
      const a = await mk();
      const res = await rotate(a.id, as(a.token), body);
      expect(res.statusCode).toBe(400);
      expect((await liveTokens(a.id)).length).toBe(1);
      expect((await healthAs(a.token)).statusCode).toBe(200);
    }
  });

  it("refuses a non-boolean rather than treating it as truthy", async () => {
    const a = await mk();
    const res = await rotate(a.id, as(a.token), { keepExisting: "yes" });
    expect(res.statusCode).toBe(400);
    // And the refusal is total: nothing was minted and nothing revoked.
    expect((await liveTokens(a.id)).length).toBe(1);
    expect((await healthAs(a.token)).statusCode).toBe(200);
  });
});

describe("the blast radius is bounded to the named agent", () => {
  it("does not touch another agent's tokens", async () => {
    const a = await mk();
    const b = await mk();
    await rotate(a.id, as(a.token));

    expect((await liveTokens(b.id)).length).toBe(1);
    expect((await healthAs(b.token)).statusCode).toBe(200);
  });

  it("an orchestrator rotating a worker retires only that worker", async () => {
    const orch = await mk("orchestrator");
    const w1 = await mk();
    const w2 = await mk();

    const res = await rotate(w1.id, as(orch.token));
    expect(res.statusCode).toBe(201);

    expect((await healthAs(w1.token)).statusCode).toBe(401);
    expect((await healthAs(w2.token)).statusCode).toBe(200);
    expect((await healthAs(orch.token)).statusCode).toBe(200);
  });
});

describe("revoking grants no authority the caller did not already have", () => {
  // This is the whole argument for revoking here rather than making it a
  // separate call. If a caller refused at DELETE /tokens/:id could reach the
  // same effect through rotation, the fix would be a privilege hole.
  it("a peer worker still cannot rotate, so it cannot revoke this way either", async () => {
    const victim = await mk();
    const peer = await mk();

    const res = await rotate(victim.id, as(peer.token));
    expect(res.statusCode).toBe(403);

    expect((await liveTokens(victim.id)).length).toBe(1);
    expect((await healthAs(victim.token)).statusCode).toBe(200);
  });

  it("every caller who may rotate may already revoke the same agent directly", async () => {
    // Self and orchestrator are the two the gate admits. Both are shown to
    // reach DELETE /tokens/:id, so rotation's revoke is not a new power.
    const orch = await mk("orchestrator");

    const self = await mk();
    const selfTokenId = (await liveTokens(self.id))[0].id;
    const r1 = await app.inject({ method: "DELETE", url: `/tokens/${selfTokenId}`, headers: as(self.token) });
    expect(r1.statusCode).toBe(204);

    const worker = await mk();
    const workerTokenId = (await liveTokens(worker.id))[0].id;
    const r2 = await app.inject({ method: "DELETE", url: `/tokens/${workerTokenId}`, headers: as(orch.token) });
    expect(r2.statusCode).toBe(204);
  });
});

describe("registration is unaffected", () => {
  it("a fresh agent gets one live token and no stray revocation", async () => {
    const a = await mk();
    const rows = await allTokens(a.id);
    expect(rows.length).toBe(1);
    expect(rows[0].revokedAt).toBeNull();
    expect((await healthAs(a.token)).statusCode).toBe(200);
  });
});
