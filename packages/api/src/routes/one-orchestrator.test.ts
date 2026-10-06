// One orchestrator per repo, enforced.
//
// task_zrn3lbqGEV4qGTb2-JH-3's delegated-authority design says a task carries
// the owner's authority only when its creator is "the orchestrator of the repo".
// That definite article was a convention the schema could not supply: nothing
// counted orchestrators, so a second one would have inherited the owner's
// delegation over every worker there, silently, and the existing orchestrator
// could mint it via an orchestrator invite.
//
// The constraint lives in the DATABASE, not only in the routes, for the same
// reason `tasks_reviewer_not_assignee` does: the routes are not the only
// writers, and a rule that only some callers pass is not an invariant.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, agents } from "@getrelai/db";
import { eq } from "drizzle-orm";
import { newId } from "../lib/id.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-one-orch";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const db = createDb(DB_URL);

let app: FastifyInstance;
let repoA: string;
let repoB: string;

const mkRepo = async (name: string) => {
  const r = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name }),
  });
  return r.json().data.id as string;
};

const mkAgent = (repoId: string, name: string, role: string) =>
  app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name, role }),
  });

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
  repoA = await mkRepo("__test__ one-orch A");
  repoB = await mkRepo("__test__ one-orch B");
});

afterAll(async () => {
  for (const id of [repoA, repoB]) {
    if (id) await app.inject({ method: "DELETE", url: `/repos/${id}`, headers: ADMIN });
  }
  await app?.close();
});

describe("a repo holds at most one orchestrator", () => {
  it("accepts the first one", async () => {
    const res = await mkAgent(repoA, "orch-one", "orchestrator");
    expect(res.statusCode).toBe(201);
  });

  it("refuses a second with a 409 that says why, not a 500", async () => {
    // A bare constraint violation would still only 500 generically (server.ts's
    // setErrorHandler already keeps the real error out of the body) — this
    // pins the useful part: a 409 that actually says what went wrong.
    const res = await mkAgent(repoA, "orch-two", "orchestrator");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
    expect(res.json().error.message).toMatch(/orchestrator/i);
  });

  it("leaves workers alone, however many", async () => {
    for (const name of ["w1", "w2", "w3"]) {
      expect((await mkAgent(repoA, name, "worker")).statusCode).toBe(201);
    }
  });

  it("counts per repo, not globally", async () => {
    expect((await mkAgent(repoB, "orch-b", "orchestrator")).statusCode).toBe(201);
  });
});

describe("the invite path is gated too, because it is the one an orchestrator can drive", () => {
  // POST /repos/:id/invites with role orchestrator is reachable by the existing
  // orchestrator, so this is exactly how today's single orchestrator would have
  // minted tomorrow's second.
  const mintOrchestratorInvite = (repoId: string) =>
    app.inject({
      method: "POST", url: `/repos/${repoId}/invites`, headers: ADMIN,
      body: JSON.stringify({ suggestedName: "second", role: "orchestrator" }),
    });

  it("refuses the redeem with a clear error rather than a 500", async () => {
    const mint = await mintOrchestratorInvite(repoA);
    expect(mint.statusCode).toBe(201);

    const join = await app.inject({
      method: "POST", url: "/auth/accept-invite", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "second-orch", code: mint.json().code }),
    });
    expect(join.statusCode).toBe(409);
    expect(join.json().error.code).toBe("conflict");
    expect(join.json().error.message).toMatch(/orchestrator/i);
  });

  it("does not burn the invite on a refused redeem", async () => {
    // accept-invite claims the row conditionally before inserting the agent. If
    // the refusal lands after the claim, the code is dead and the operator has
    // to mint another to fix the thing that caused the refusal.
    const mint = await mintOrchestratorInvite(repoA);
    const code = mint.json().code as string;

    const refused = await app.inject({
      method: "POST", url: "/auth/accept-invite", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "burn-check", code }),
    });
    expect(refused.statusCode).toBe(409);

    // Remove the incumbent, then the same code must still work.
    const [incumbent] = await db.select().from(agents)
      .where(eq(agents.repoId, repoA)).then((rows) => rows.filter((a) => a.role === "orchestrator"));
    await app.inject({ method: "DELETE", url: `/agents/${incumbent.id}`, headers: ADMIN });

    const retry = await app.inject({
      method: "POST", url: "/auth/accept-invite", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "burn-check", code }),
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().data.role).toBe("orchestrator");
  });
});

describe("the database holds the line, because the routes are not the only writers", () => {
  it("rejects a direct insert of a second orchestrator", async () => {
    // The seed scripts, add-agent.ts and any future path write this table
    // without passing a route. A rule enforced only in a handler is a
    // convention; this is the same reasoning as tasks_reviewer_not_assignee.
    await expect(
      db.insert(agents).values({
        id: newId("agent"),
        repoId: repoB,
        name: `direct-${Date.now()}`,
        role: "orchestrator",
        domains: [],
        lastSeenAt: new Date(0),
      }),
    ).rejects.toThrow();
  });

  it("still permits a direct insert of a worker", async () => {
    await expect(
      db.insert(agents).values({
        id: newId("agent"),
        repoId: repoB,
        name: `direct-worker-${Date.now()}`,
        role: "worker",
        domains: [],
        lastSeenAt: new Date(0),
      }),
    ).resolves.toBeDefined();
  });

  it("frees the slot when the orchestrator is deleted", async () => {
    const [orch] = (await db.select().from(agents).where(eq(agents.repoId, repoB)))
      .filter((a) => a.role === "orchestrator");
    await app.inject({ method: "DELETE", url: `/agents/${orch.id}`, headers: ADMIN });
    expect((await mkAgent(repoB, "orch-b-again", "orchestrator")).statusCode).toBe(201);
  });
});

describe("the index is the only guard, so concurrent attempts must still resolve to exactly one winner", () => {
  // A sequential conflict only ever exercises isConstraintViolation()'s
  // .cause-unwrap against a post-hoc index check. Real concurrent contention
  // hits Postgres while the index is actually being written, which could in
  // principle surface a different error shape (a lock wait, a serialization
  // failure) that the unwrap doesn't recognize — this is the test that would
  // catch that, the same reasoning owner-grant.test.ts's "one invite is one
  // credential, under concurrency" test gives for firing requests together
  // rather than one after another.
  it("lets exactly one of N simultaneous registrations win", async () => {
    const repoC = await mkRepo("__test__ one-orch concurrent");
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => mkAgent(repoC, `race-${i}`, "orchestrator")),
      );
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
      for (const r of results) {
        if (r.statusCode === 409) expect(r.json().error.code).toBe("conflict");
      }
    } finally {
      await app.inject({ method: "DELETE", url: `/repos/${repoC}`, headers: ADMIN });
    }
  });
});
