// A reviewer-gated task is only worth gating if the reviewer is someone other
// than the person doing the work. Two separate properties hold that up, and the
// hole this file pins needed both: re-pointing the reviewer is an orchestrator
// act, AND the reviewer may never be the assignee, whoever is asking.
//
// The original escalation (task_XdnIh_VlB6cOaPJG7-MQV) defeated the completion
// gate by satisfying it honestly rather than bypassing it: the assignee re-pointed
// verifyReviewerId at itself, then approved. Every downstream check passed,
// including the consistency check in verify-reviewer-agent.ts, because by that
// point both sides named the same agent.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { routePendingTasks } from "../lib/router/scheduler.js";
import { createDb, tasks, agents } from "@getrelai/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-reviewer-integrity";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
let repoId: string;
let orchId: string, orchTok: string;
let doerId: string, doerTok: string;
let reviewerId: string, reviewerTok: string;
let thirdId: string, thirdTok: string;
const db = createDb(DB_URL);

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const r = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ reviewer-integrity" }),
  });
  repoId = r.json().data.id;

  const mk = async (name: string, role: string) => {
    const a = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name, role }),
    });
    return { id: a.json().data.id as string, token: a.json().token as string };
  };
  ({ id: orchId, token: orchTok } = await mk("ri-orch", "orchestrator"));
  ({ id: doerId, token: doerTok } = await mk("ri-doer", "worker"));
  ({ id: reviewerId, token: reviewerTok } = await mk("ri-reviewer", "worker"));
  ({ id: thirdId, token: thirdTok } = await mk("ri-third", "worker"));
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

// A reviewer-gated task assigned to the doer, reviewed by someone else.
async function gatedTask(overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({
      repoId, createdBy: orchId, title: "gated", description: "d",
      assignedTo: doerId, verifyKind: "reviewer_agent", verifyReviewerId: reviewerId,
      ...overrides,
    }),
  });
  return res;
}

describe("re-pointing the reviewer is an orchestrator act", () => {
  it("refuses a worker changing verifyReviewerId, which is the reported escalation", async () => {
    const id = (await gatedTask()).json().data.id;
    const res = await app.inject({
      method: "PUT", url: `/tasks/${id}`, headers: as(doerTok),
      body: JSON.stringify({ verifyReviewerId: doerId }),
    });
    expect(res.statusCode).toBe(403);

    const after = await app.inject({ method: "GET", url: `/tasks/${id}`, headers: ADMIN });
    expect(after.json().data.verifyReviewerId).toBe(reviewerId);
  });

  it("refuses a worker re-pointing it at an innocent third party too", async () => {
    // Not only self-review: choosing a friendlier reviewer is the same integrity
    // break, so the gate is on WHO MAY CHANGE it, not on the value.
    const id = (await gatedTask()).json().data.id;
    const res = await app.inject({
      method: "PUT", url: `/tasks/${id}`, headers: as(doerTok),
      body: JSON.stringify({ verifyReviewerId: thirdId }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets an orchestrator re-point it at a different agent", async () => {
    const id = (await gatedTask()).json().data.id;
    const res = await app.inject({
      method: "PUT", url: `/tasks/${id}`, headers: as(orchTok),
      body: JSON.stringify({ verifyReviewerId: thirdId }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.verifyReviewerId).toBe(thirdId);
  });

  it("still lets a worker edit the rest of its own task", async () => {
    const id = (await gatedTask()).json().data.id;
    const res = await app.inject({
      method: "PUT", url: `/tasks/${id}`, headers: as(doerTok),
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(res.statusCode).toBe(200);
  });
});

// The invariant, which holds for every caller including an orchestrator and the
// admin path: a review by the person who did the work is not a review.
describe("the reviewer may never be the assignee", () => {
  it("refuses it at create, even on the admin path", async () => {
    const res = await gatedTask({ verifyReviewerId: doerId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/assignee/i);
  });

  it("refuses an orchestrator pointing the reviewer at the assignee", async () => {
    const id = (await gatedTask()).json().data.id;
    const res = await app.inject({
      method: "PUT", url: `/tasks/${id}`, headers: as(orchTok),
      body: JSON.stringify({ verifyReviewerId: doerId }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/assignee/i);
  });

  // The other direction, and the one a reviewer-only check misses entirely:
  // leave the reviewer alone and move the ASSIGNEE onto it. The update's verify
  // validation only runs when a verify field is in the body, so a lone
  // assignedTo change skipped it.
  it("refuses moving the assignee onto the existing reviewer", async () => {
    const id = (await gatedTask()).json().data.id;
    const res = await app.inject({
      method: "PUT", url: `/tasks/${id}`, headers: as(orchTok),
      body: JSON.stringify({ assignedTo: reviewerId }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/assignee/i);

    const after = await app.inject({ method: "GET", url: `/tasks/${id}`, headers: ADMIN });
    expect(after.json().data.assignedTo).toBe(doerId);
  });

  it("refuses the reviewer taking the work itself", async () => {
    // PUT /tasks/:id applies no authorization to assignedTo, so any member can
    // reassign any task. The reviewer using that to take its own gated task is
    // the self-service version, and it must be refused on the value, not the role.
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: orchId, title: "gated", description: "d",
        assignedTo: doerId, verifyKind: "reviewer_agent", verifyReviewerId: thirdId,
      }),
    });
    const id = created.json().data.id;
    const res = await app.inject({
      method: "PUT", url: `/tasks/${id}`, headers: as(thirdTok),
      body: JSON.stringify({ assignedTo: thirdId }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/assignee/i);
  });

  it("refuses a commit that would land the assignee on the reviewer", async () => {
    // A worker's proposal carrying a reviewer, committed to that same agent.
    const proposed = await app.inject({
      method: "POST", url: "/tasks", headers: as(doerTok),
      body: JSON.stringify({
        repoId, createdBy: doerId, title: "proposed gated", description: "d",
        verifyKind: "reviewer_agent", verifyReviewerId: reviewerId,
      }),
    });
    expect(proposed.json().data.status).toBe("proposed");
    const res = await app.inject({
      method: "POST", url: `/tasks/${proposed.json().data.id}/commit`, headers: as(orchTok),
      body: JSON.stringify({ assignedTo: reviewerId }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/assignee/i);
  });

  it("allows a commit to a different agent", async () => {
    const proposed = await app.inject({
      method: "POST", url: "/tasks", headers: as(doerTok),
      body: JSON.stringify({
        repoId, createdBy: doerId, title: "proposed gated ok", description: "d",
        verifyKind: "reviewer_agent", verifyReviewerId: reviewerId,
      }),
    });
    const res = await app.inject({
      method: "POST", url: `/tasks/${proposed.json().data.id}/commit`, headers: as(orchTok),
      body: JSON.stringify({ assignedTo: thirdId }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.assignedTo).toBe(thirdId);
    expect(res.json().data.verifyReviewerId).toBe(reviewerId);
  });

  it("leaves a task with no reviewer predicate alone", async () => {
    // The guard must not interfere with ordinary assignment on the vast
    // majority of tasks, which have no reviewer at all.
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({ repoId, createdBy: orchId, title: "plain", description: "d", assignedTo: doerId }),
    });
    const res = await app.inject({
      method: "PUT", url: `/tasks/${created.json().data.id}`, headers: as(orchTok),
      body: JSON.stringify({ assignedTo: reviewerId }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.assignedTo).toBe(reviewerId);
  });
});

// The route guards are not enough on their own, and this is why. Three writers
// set assignedTo with no request behind them: the routing scheduler filling in an
// @auto task, the stall reaper re-queueing, and the DELETE /agents/:id cascade.
// The first one restored the whole escalation — a worker proposes with
// assignedTo:"@auto" and itself as reviewer, and the router hands it back.
describe("writers with no caller cannot produce a self-review either", () => {
  it("the router will not assign a gated task to its own reviewer", async () => {
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: orchId, title: "auto gated", description: "d",
        assignedTo: "@auto", verifyKind: "reviewer_agent", verifyReviewerId: reviewerId,
      }),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id;
    expect(created.json().data.assignedTo).toBeNull();
    expect(created.json().data.autoAssign).toBe(true);

    // Everyone online, so the reviewer is a live candidate the router could pick.
    await db.update(agents).set({ lastSeenAt: new Date() }).where(eq(agents.repoId, repoId));
    await routePendingTasks(db, repoId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.assignedTo).not.toBe(reviewerId);
  });

  it("…and leaves it pending rather than picking the reviewer when it is the only candidate", async () => {
    // A project whose sole worker is the reviewer. Assigning is impossible; the
    // task must wait, not be forced onto the one agent that may not have it.
    const solo = await app.inject({
      method: "POST", url: "/repos", headers: ADMIN,
      body: JSON.stringify({ name: `__test__ ri-solo-${Date.now()}` }),
    });
    const soloRepo = solo.json().data.id;
    const w = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId: soloRepo, name: "solo-worker", role: "worker" }),
    });
    const soloWorker = w.json().data.id;

    const t = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId: soloRepo, createdBy: soloWorker, title: "solo", description: "d",
        assignedTo: "@auto", verifyKind: "reviewer_agent", verifyReviewerId: soloWorker,
      }),
    });
    const id = t.json().data.id;
    await db.update(agents).set({ lastSeenAt: new Date() }).where(eq(agents.repoId, soloRepo));
    await routePendingTasks(db, soloRepo);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.assignedTo).toBeNull();
    expect(row.status).toBe("pending");
    await app.inject({ method: "DELETE", url: `/repos/${soloRepo}`, headers: ADMIN });
  });

  // The backstop. Every route and the router now refuse the pair, but the
  // invariant is enforced where the writes land, so a future writer that forgets
  // cannot persist it either.
  it("the database refuses the pair even when written directly", async () => {
    const id = (await gatedTask()).json().data.id;
    // drizzle wraps the driver error, so the constraint name is on the cause
    // rather than in the message it prints.
    let caught: unknown;
    try {
      await db.update(tasks).set({ assignedTo: reviewerId }).where(eq(tasks.id, id));
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const detail = JSON.stringify({ m: String(caught), c: String((caught as { cause?: unknown }).cause ?? "") });
    expect(detail).toMatch(/tasks_reviewer_not_assignee/);
  });

  it("…and the constraint does not disturb a task with only one side set", async () => {
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({ repoId, createdBy: orchId, title: "no reviewer", description: "d" }),
    });
    const id = created.json().data.id;
    await db.update(tasks).set({ assignedTo: reviewerId }).where(eq(tasks.id, id));
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.assignedTo).toBe(reviewerId);
    expect(row.verifyReviewerId).toBeNull();
  });
});
