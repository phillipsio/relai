import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

// Propose-vs-commit: a worker's create_task is a *proposal* (status "proposed",
// no assignee, withheld from the scheduler) that an orchestrator must commit
// before it enters the normal lifecycle. Orchestrators (and the deprecated
// admin-secret path) commit directly on create, preserving today's behavior.
const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-propose";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}` };
const json   = (extra: Record<string, string>) => ({ ...extra, "Content-Type": "application/json" });

let app: FastifyInstance;
let projectId: string;
let orchId: string;
let orchAuth: { Authorization: string };
let workerId: string;
let workerAuth: { Authorization: string };
let otherWorkerId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/projects",
    headers: json(ADMIN),
    body: JSON.stringify({ name: "__test__ propose-commit" }),
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().data.id;

  const orch = await app.inject({
    method: "POST", url: "/agents",
    headers: json(ADMIN),
    body: JSON.stringify({ projectId, name: "lead", role: "orchestrator" }),
  });
  orchId   = orch.json().data.id;
  orchAuth = { Authorization: `Bearer ${orch.json().token}` };

  const worker = await app.inject({
    method: "POST", url: "/agents",
    headers: json(ADMIN),
    body: JSON.stringify({ projectId, name: "worker-a", role: "worker" }),
  });
  workerId   = worker.json().data.id;
  workerAuth = { Authorization: `Bearer ${worker.json().token}` };

  const other = await app.inject({
    method: "POST", url: "/agents",
    headers: json(ADMIN),
    body: JSON.stringify({ projectId, name: "worker-b", role: "worker" }),
  });
  otherWorkerId = other.json().data.id;
});

afterAll(async () => {
  if (projectId) await app.inject({ method: "DELETE", url: `/projects/${projectId}`, headers: ADMIN });
  await app?.close();
});

// Convenience: create a task as a given identity, return the parsed body.
async function create(auth: { Authorization: string }, body: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST", url: "/tasks", headers: json(auth),
    body: JSON.stringify({ projectId, createdBy: workerId, title: "t", description: "d", ...body }),
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
      body: JSON.stringify({ projectId, createdBy: orchId, title: "t", description: "d" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe("pending");
  });

  it("an orchestrator's create with an assignee is committed (assigned)", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks", headers: json(orchAuth),
      body: JSON.stringify({ projectId, createdBy: orchId, title: "t", description: "d", assignedTo: workerId }),
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
      body: JSON.stringify({ projectId, createdBy: orchId, title: "t", description: "d" }),
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
