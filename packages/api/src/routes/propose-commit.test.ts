import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, tasks, users } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

// Propose-vs-commit: a worker's create_task is a *proposal* (status "proposed",
// no assignee, withheld from the scheduler) that an orchestrator must commit
// before it enters the normal lifecycle. Orchestrators (and the deprecated
// admin-secret path) commit directly on create, preserving today's behavior.
const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-propose";
const SERVICE_TOKEN = "test-service-admin-propose";

process.env.DATABASE_URL        = DB_URL;
process.env.API_SECRET          = SECRET;
process.env.SERVICE_ADMIN_TOKEN = SERVICE_TOKEN;

const db = createDb(DB_URL);

const ADMIN = { Authorization: `Bearer ${SECRET}` };
const json   = (extra: Record<string, string>) => ({ ...extra, "Content-Type": "application/json" });

let app: FastifyInstance;
let repoId: string;
let orchId: string;
let orchAuth: { Authorization: string };
let workerId: string;
let workerAuth: { Authorization: string };
let otherWorkerId: string;
const ownedRepos: string[] = [];
const ownedUsers: string[] = [];

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/repos",
    headers: json(ADMIN),
    body: JSON.stringify({ name: "__test__ propose-commit" }),
  });
  expect(project.statusCode).toBe(201);
  repoId = project.json().data.id;

  const orch = await app.inject({
    method: "POST", url: "/agents",
    headers: json(ADMIN),
    body: JSON.stringify({ repoId, name: "lead", role: "orchestrator" }),
  });
  orchId   = orch.json().data.id;
  orchAuth = { Authorization: `Bearer ${orch.json().token}` };

  const worker = await app.inject({
    method: "POST", url: "/agents",
    headers: json(ADMIN),
    body: JSON.stringify({ repoId, name: "worker-a", role: "worker" }),
  });
  workerId   = worker.json().data.id;
  workerAuth = { Authorization: `Bearer ${worker.json().token}` };

  const other = await app.inject({
    method: "POST", url: "/agents",
    headers: json(ADMIN),
    body: JSON.stringify({ repoId, name: "worker-b", role: "worker" }),
  });
  otherWorkerId = other.json().data.id;
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  for (const id of ownedRepos) await app.inject({ method: "DELETE", url: `/repos/${id}`, headers: ADMIN });
  for (const id of ownedUsers) await db.delete(users).where(eq(users.id, id));
  await app?.close();
});

// Convenience: create a task as a given identity, return the parsed body.
async function create(auth: { Authorization: string }, body: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST", url: "/tasks", headers: json(auth),
    body: JSON.stringify({ repoId, createdBy: workerId, title: "t", description: "d", ...body }),
  });
  return { status: res.statusCode, data: res.json().data, body: res.json() };
}

describe("POST /tasks — worker proposals", () => {
  it("a worker's create lands in 'proposed' with no assignee", async () => {
    const { status, data } = await create(workerAuth, { createdBy: workerId });
    expect(status).toBe(201);
    expect(data.status).toBe("proposed");
    expect(data.assignedTo).toBeNull();
    expect(data.autoAssign).toBe(false);
    // No suggested assignee captured when none was sent.
    expect(data.metadata?.proposal?.suggestedAssignee ?? null).toBeNull();
  });

  it("preserves a worker's suggested assignee as a non-binding hint", async () => {
    const { data } = await create(workerAuth, { createdBy: workerId, assignedTo: otherWorkerId });
    expect(data.status).toBe("proposed");
    expect(data.assignedTo).toBeNull();
    expect(data.metadata.proposal.suggestedAssignee).toBe(otherWorkerId);
  });

  it("preserves a worker's '@auto' suggestion without auto-assigning", async () => {
    const { data } = await create(workerAuth, { createdBy: workerId, assignedTo: "@auto" });
    expect(data.status).toBe("proposed");
    expect(data.autoAssign).toBe(false);
    expect(data.metadata.proposal.suggestedAssignee).toBe("@auto");
  });

  it("ignores a client-supplied status on a worker proposal", async () => {
    const { data } = await create(workerAuth, { createdBy: workerId, status: "assigned" });
    expect(data.status).toBe("proposed");
  });

  it("carries authored fields (verify, domains, priority) onto the proposal", async () => {
    const { data } = await create(workerAuth, {
      createdBy: workerId, priority: "high", domains: ["api"],
      verifyKind: "file_exists", verifyPath: "dist/x",
    });
    expect(data.status).toBe("proposed");
    expect(data.priority).toBe("high");
    expect(data.domains).toEqual(["api"]);
    expect(data.verifyKind).toBe("file_exists");
    expect(data.verifyPath).toBe("dist/x");
  });

  it("auto-subscribes the orchestrator to a proposed task", async () => {
    const { data } = await create(workerAuth, { createdBy: workerId });
    const subs = await app.inject({
      method: "GET", url: `/subscriptions?agentId=${orchId}`, headers: orchAuth,
    });
    const rows = subs.json().data as Array<{ targetType: string; targetId: string }>;
    expect(rows.some((s) => s.targetType === "task" && s.targetId === data.id)).toBe(true);
  });
});

describe("POST /tasks — orchestrator / admin commit directly", () => {
  it("an orchestrator's create is committed (pending when unassigned)", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks", headers: json(orchAuth),
      body: JSON.stringify({ repoId, createdBy: orchId, title: "t", description: "d" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe("pending");
  });

  it("an orchestrator's create with an assignee is committed (assigned)", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks", headers: json(orchAuth),
      body: JSON.stringify({ repoId, createdBy: orchId, title: "t", description: "d", assignedTo: workerId }),
    });
    expect(res.json().data.status).toBe("assigned");
    expect(res.json().data.assignedTo).toBe(workerId);
  });

  it("the admin-secret path commits directly (acts as orchestrator)", async () => {
    const { status, data } = await create(ADMIN, { createdBy: orchId });
    expect(status).toBe(201);
    expect(data.status).toBe("pending");
  });
});

describe("POST /tasks/:id/commit", () => {
  // Helper: a fresh worker proposal to operate on.
  async function proposal(extra: Record<string, unknown> = {}) {
    const { data } = await create(workerAuth, { createdBy: workerId, ...extra });
    expect(data.status).toBe("proposed");
    return data.id as string;
  }

  it("orchestrator commits a proposal to a concrete assignee → assigned", async () => {
    const id = await proposal({ assignedTo: workerId });
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(orchAuth),
      body: JSON.stringify({ assignedTo: workerId }),
    });
    expect(res.statusCode).toBe(200);
    const t = res.json().data;
    expect(t.status).toBe("assigned");
    expect(t.assignedTo).toBe(workerId);
    expect(t.metadata.commit.committedBy).toBe(orchId);
  });

  it("commit with '@auto' → pending + autoAssign", async () => {
    const id = await proposal();
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(orchAuth),
      body: JSON.stringify({ assignedTo: "@auto" }),
    });
    const t = res.json().data;
    expect(t.status).toBe("pending");
    expect(t.autoAssign).toBe(true);
    expect(t.assignedTo).toBeNull();
  });

  it("commit with no assignee falls back to the project default (pending here)", async () => {
    const id = await proposal();
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(orchAuth),
      body: JSON.stringify({}),
    });
    expect(res.json().data.status).toBe("pending");
  });

  it("commit applies ratified edits (priority, title)", async () => {
    const id = await proposal();
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(orchAuth),
      body: JSON.stringify({ assignedTo: workerId, priority: "urgent", title: "ratified" }),
    });
    const t = res.json().data;
    expect(t.priority).toBe("urgent");
    expect(t.title).toBe("ratified");
  });

  it("a worker cannot commit a proposal (403)", async () => {
    const id = await proposal();
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(workerAuth),
      body: JSON.stringify({ assignedTo: workerId }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("the admin-secret path may commit (stands in for orchestrator)", async () => {
    const id = await proposal();
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(ADMIN),
      body: JSON.stringify({ assignedTo: workerId }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("assigned");
  });

  it("rejecting a proposal cancels it", async () => {
    const id = await proposal();
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(orchAuth),
      body: JSON.stringify({ decision: "reject", note: "out of scope" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("cancelled");
  });

  it("committing a non-proposed task → 409", async () => {
    // An orchestrator create is already committed (pending), not proposed.
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: json(orchAuth),
      body: JSON.stringify({ repoId, createdBy: orchId, title: "t", description: "d" }),
    });
    const id = created.json().data.id;
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(orchAuth),
      body: JSON.stringify({ assignedTo: workerId }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("wrong_state");
  });

  it("re-validates verify config on commit edits (cross-kind → 400)", async () => {
    const id = await proposal({ verifyKind: "file_exists", verifyPath: "dist/x" });
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(orchAuth),
      body: JSON.stringify({ assignedTo: workerId, verifyReviewerId: orchId }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("commit of an unknown task → 404", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks/task_nope/commit", headers: json(orchAuth),
      body: JSON.stringify({ assignedTo: workerId }),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /tasks/:id/commit — the committed row owns its assignee", () => {
  it("'@auto' clears an assignee already on the row, rather than inheriting it", async () => {
    const { data } = await create(workerAuth, { createdBy: workerId });
    expect(data.status).toBe("proposed");
    // Written straight to the column: the commit route's invariant must hold
    // however the value got there, not only when the routes upstream refuse it.
    await db.update(tasks).set({ assignedTo: workerId }).where(eq(tasks.id, data.id));

    const res = await app.inject({
      method: "POST", url: `/tasks/${data.id}/commit`, headers: json(orchAuth),
      body: JSON.stringify({ assignedTo: "@auto" }),
    });
    expect(res.statusCode).toBe(200);
    const t = res.json().data;
    expect(t.autoAssign).toBe(true);
    expect(t.status).toBe("pending");
    expect(t.assignedTo).toBeNull();
  });

  it("an omitted assignee also clears one already on the row", async () => {
    const { data } = await create(workerAuth, { createdBy: workerId });
    await db.update(tasks).set({ assignedTo: workerId }).where(eq(tasks.id, data.id));
    const res = await app.inject({
      method: "POST", url: `/tasks/${data.id}/commit`, headers: json(orchAuth),
      body: JSON.stringify({}),
    });
    expect(res.json().data.assignedTo).toBeNull();
    expect(res.json().data.status).toBe("pending");
  });
});

describe("POST /tasks/:id/commit — a proposer may withdraw its own proposal", () => {
  async function proposal() {
    const { data } = await create(workerAuth, { createdBy: workerId });
    expect(data.status).toBe("proposed");
    return data.id as string;
  }

  it("the proposer rejects its own proposal → cancelled", async () => {
    const id = await proposal();
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(workerAuth),
      body: JSON.stringify({ decision: "reject", note: "filed twice" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("cancelled");
    expect(res.json().data.metadata.proposal.rejectedBy).toBe(workerId);
  });

  it("the proposer still cannot commit its own proposal", async () => {
    const id = await proposal();
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(workerAuth),
      body: JSON.stringify({ decision: "commit", assignedTo: workerId }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("withdrawal is the proposer's alone — another worker cannot reject it", async () => {
    const id = await proposal();
    const other = await app.inject({
      method: "POST", url: "/agents", headers: json(ADMIN),
      body: JSON.stringify({ repoId, name: `worker-reject-${Date.now()}`, role: "worker" }),
    });
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`,
      headers: json({ Authorization: `Bearer ${other.json().token}` }),
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(res.statusCode).toBe(403);
    const after = await app.inject({ method: "GET", url: `/tasks/${id}`, headers: ADMIN });
    expect(after.json().data.status).toBe("proposed");
  });
});

describe("PUT /tasks/:id — a proposal leaves 'proposed' only through commit", () => {
  async function proposal(extra: Record<string, unknown> = {}) {
    const { data } = await create(workerAuth, { createdBy: workerId, ...extra });
    expect(data.status).toBe("proposed");
    return data.id as string;
  }

  async function put(id: string, auth: Record<string, string>, body: Record<string, unknown>) {
    return app.inject({ method: "PUT", url: `/tasks/${id}`, headers: json(auth), body: JSON.stringify(body) });
  }

  async function read(id: string) {
    const res = await app.inject({ method: "GET", url: `/tasks/${id}`, headers: ADMIN });
    return res.json().data;
  }

  it("a worker cannot start its own proposal, and the row does not move", async () => {
    const id = await proposal();
    const res = await put(id, workerAuth, { status: "in_progress" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("wrong_state");
    expect((await read(id)).status).toBe("proposed");
  });

  it("a worker cannot assign its own proposal to itself", async () => {
    const id = await proposal();
    const res = await put(id, workerAuth, { status: "assigned", assignedTo: workerId });
    expect(res.statusCode).toBe(409);
    const after = await read(id);
    expect(after.status).toBe("proposed");
    expect(after.assignedTo).toBeNull();
  });

  it("a worker cannot pre-pick its executor without touching status either", async () => {
    const id = await proposal();
    const res = await put(id, workerAuth, { assignedTo: workerId });
    expect(res.statusCode).toBe(409);
    expect((await read(id)).assignedTo).toBeNull();
  });

  it("a worker cannot withdraw a proposal by cancelling it", async () => {
    const id = await proposal();
    const res = await put(id, workerAuth, { status: "cancelled" });
    expect(res.statusCode).toBe(409);
    expect((await read(id)).status).toBe("proposed");
  });

  it("an orchestrator gets the same refusal — commit is the only exit", async () => {
    const id = await proposal();
    const res = await put(id, orchAuth, { status: "assigned", assignedTo: workerId });
    expect(res.statusCode).toBe(409);
    expect((await read(id)).status).toBe("proposed");
  });

  it("the admin-secret path gets the same refusal", async () => {
    const id = await proposal();
    const res = await put(id, ADMIN, { status: "assigned", assignedTo: workerId });
    expect(res.statusCode).toBe(409);
    expect((await read(id)).status).toBe("proposed");
  });

  it("the commit route still works on a task a PUT was refused for", async () => {
    const id = await proposal();
    expect((await put(id, workerAuth, { status: "in_progress" })).statusCode).toBe(409);
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(orchAuth),
      body: JSON.stringify({ assignedTo: workerId }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("assigned");
  });

  it("a title edit on a proposal is still allowed", async () => {
    const id = await proposal();
    const res = await put(id, workerAuth, { title: "clarified" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.title).toBe("clarified");
    expect(res.json().data.status).toBe("proposed");
  });

  it("a description edit on a proposal is still allowed", async () => {
    const id = await proposal();
    const res = await put(id, workerAuth, { description: "more detail" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.description).toBe("more detail");
  });

  it("a priority edit on a proposal is still allowed", async () => {
    const id = await proposal();
    const res = await put(id, workerAuth, { priority: "high" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.priority).toBe("high");
  });

  it("a verify-predicate edit on a proposal is still allowed", async () => {
    const id = await proposal();
    const res = await put(id, workerAuth, { verifyKind: "file_exists", verifyPath: "dist/out.js" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.verifyKind).toBe("file_exists");
    expect(res.json().data.verifyPath).toBe("dist/out.js");
  });

  it("a status change on a task that is not a proposal is unaffected", async () => {
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: json(orchAuth),
      body: JSON.stringify({ repoId, createdBy: orchId, title: "t", description: "d", assignedTo: workerId }),
    });
    const id = created.json().data.id;
    const res = await put(id, workerAuth, { status: "in_progress" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("in_progress");
  });

  it("an assignee change on a task that is not a proposal is unaffected", async () => {
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: json(orchAuth),
      body: JSON.stringify({ repoId, createdBy: orchId, title: "t", description: "d" }),
    });
    const id = created.json().data.id;
    const res = await put(id, orchAuth, { assignedTo: workerId });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.assignedTo).toBe(workerId);
  });

  // The fourth caller type: service-admin token + X-Owner-Id, which resolves
  // access by repo ownership rather than by an agent row or the shared secret.
  it("the owner-scoped service-admin path gets the same refusal", async () => {
    const ownerId = `usr_propose_${Date.now()}`;
    await db.insert(users).values({ id: ownerId, email: `${ownerId}@test.local` });
    ownedUsers.push(ownerId);
    const owned = await app.inject({
      method: "POST", url: "/repos",
      headers: json({ Authorization: `Bearer ${SERVICE_TOKEN}`, "X-Owner-Id": ownerId }),
      body: JSON.stringify({ name: `__test__ propose-owner-${Date.now()}` }),
    });
    const ownedRepo = owned.json().data.id;
    ownedRepos.push(ownedRepo);

    const hand = await app.inject({
      method: "POST", url: "/agents", headers: json(ADMIN),
      body: JSON.stringify({ repoId: ownedRepo, name: "owned-worker", role: "worker" }),
    });
    const handId = hand.json().data.id;
    const proposed = await app.inject({
      method: "POST", url: "/tasks",
      headers: json({ Authorization: `Bearer ${hand.json().token}` }),
      body: JSON.stringify({ repoId: ownedRepo, createdBy: handId, title: "t", description: "d" }),
    });
    expect(proposed.json().data.status).toBe("proposed");

    const res = await put(proposed.json().data.id, { Authorization: `Bearer ${SERVICE_TOKEN}`, "X-Owner-Id": ownerId }, { status: "assigned", assignedTo: handId });
    expect(res.statusCode).toBe(409);
    expect((await read(proposed.json().data.id)).status).toBe("proposed");
  });
});

describe("POST /tasks — createdBy is the authenticated caller, not the body", () => {
  it("an agent token cannot file a proposal under another agent's name", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks", headers: json(workerAuth),
      body: JSON.stringify({ repoId, createdBy: otherWorkerId, title: "t", description: "d" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.createdBy).toBe(workerId);
  });

  it("so the proposer, not the named agent, is the one who can withdraw it", async () => {
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: json(workerAuth),
      body: JSON.stringify({ repoId, createdBy: otherWorkerId, title: "t", description: "d" }),
    });
    const id = created.json().data.id;
    const res = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(workerAuth),
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("cancelled");
  });

  it("the agentless admin path still carries its own createdBy", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks", headers: json(ADMIN),
      body: JSON.stringify({ repoId, createdBy: "human", title: "t", description: "d" }),
    });
    expect(res.json().data.createdBy).toBe("human");
  });
});

describe("POST /tasks/:id/commit — commit and withdraw cannot both win", () => {
  // The proposer and an orchestrator are the two natural concurrent actors on a
  // proposal, so the decision has to be carried by the UPDATE rather than by a
  // status read that happened earlier in the request.
  it("a commit racing a withdrawal leaves one winner, and the losers are told", async () => {
    // A pair that happens to serialize is refused by the read-time guard and
    // would pass even with the write's status predicate gone, so the test also
    // asserts that the pairs genuinely interleaved.
    let racedAtTheWrite = 0;
    for (let i = 0; i < 8; i++) {
      const { data } = await create(workerAuth, { createdBy: workerId });
      const [a, b] = await Promise.all([
        app.inject({
          method: "POST", url: `/tasks/${data.id}/commit`, headers: json(orchAuth),
          body: JSON.stringify({ assignedTo: workerId }),
        }),
        app.inject({
          method: "POST", url: `/tasks/${data.id}/commit`, headers: json(workerAuth),
          body: JSON.stringify({ decision: "reject" }),
        }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toEqual([200, 409]);
      const loser = a.statusCode === 409 ? a : b;
      if (loser.json().error.message.includes("already committed or rejected")) racedAtTheWrite++;

      const row = await app.inject({ method: "GET", url: `/tasks/${data.id}`, headers: ADMIN });
      const winner = a.statusCode === 200 ? a : b;
      expect(row.json().data.status).toBe(winner.json().data.status);
    }
    expect(racedAtTheWrite).toBeGreaterThan(0);
  });
});
