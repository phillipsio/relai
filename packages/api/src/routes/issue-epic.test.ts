import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

// Path A of the Epic → Issue reframe: tasks gain an epicId (parent "plan" thread)
// and a lazily-created comment thread, surfaced via /tasks/:id/comments. These
// are the data links the unified UI renders; no entity merge.
const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-issue-epic";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}` };
const json  = (extra: Record<string, string>) => ({ ...extra, "Content-Type": "application/json" });

let app: FastifyInstance;
let projectId: string;
let orchId: string;
let epicId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/projects", headers: json(ADMIN),
    body: JSON.stringify({ name: "__test__ issue-epic" }),
  });
  projectId = project.json().data.id;

  const orch = await app.inject({
    method: "POST", url: "/agents", headers: json(ADMIN),
    body: JSON.stringify({ projectId, name: "lead", role: "orchestrator" }),
  });
  orchId = orch.json().data.id;

  // An Epic is a "plan" thread.
  const epic = await app.inject({
    method: "POST", url: "/threads", headers: json(ADMIN),
    body: JSON.stringify({ projectId, title: "Phase 5 fan-out", type: "plan" }),
  });
  epicId = epic.json().data.id;
});

afterAll(async () => {
  if (projectId) await app.inject({ method: "DELETE", url: `/projects/${projectId}`, headers: ADMIN });
  await app?.close();
});

async function createIssue(body: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST", url: "/tasks", headers: json(ADMIN),
    body: JSON.stringify({ projectId, createdBy: orchId, title: "issue", description: "d", ...body }),
  });
  return res;
}

describe("epicId (Issue ↔ Epic parent link)", () => {
  it("stores epicId on create", async () => {
    const res = await createIssue({ epicId });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.epicId).toBe(epicId);
  });

  it("filters tasks by epicId (an Epic's child issues)", async () => {
    await createIssue({ epicId, title: "child A" });
    await createIssue({ epicId, title: "child B" });
    await createIssue({ title: "unrelated" }); // no epic

    const res = await app.inject({
      method: "GET", url: `/tasks?projectId=${projectId}&epicId=${epicId}`, headers: ADMIN,
    });
    const rows = res.json().data as Array<{ epicId: string; title: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.epicId === epicId)).toBe(true);
    expect(rows.some((r) => r.title === "unrelated")).toBe(false);
  });

  it("re-points epicId via PUT and commit via the commit endpoint", async () => {
    // Worker proposal (no epic), then orchestrator commits it under the Epic.
    const worker = await app.inject({
      method: "POST", url: "/agents", headers: json(ADMIN),
      body: JSON.stringify({ projectId, name: "w-epic", role: "worker" }),
    });
    const workerAuth = { Authorization: `Bearer ${worker.json().token}` };
    const proposed = await app.inject({
      method: "POST", url: "/tasks", headers: json(workerAuth),
      body: JSON.stringify({ projectId, createdBy: worker.json().data.id, title: "p", description: "d" }),
    });
    const id = proposed.json().data.id;
    expect(proposed.json().data.status).toBe("proposed");

    const committed = await app.inject({
      method: "POST", url: `/tasks/${id}/commit`, headers: json(ADMIN),
      body: JSON.stringify({ assignedTo: "@auto", epicId }),
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().data.epicId).toBe(epicId);
  });
});

describe("/tasks/:id/comments (Issue comment thread)", () => {
  it("lazily creates + links a thread on first read, then reuses it", async () => {
    const issue = await createIssue({ title: "needs discussion" });
    const id = issue.json().data.id;
    expect(issue.json().data.threadId ?? null).toBeNull();

    const first = await app.inject({ method: "GET", url: `/tasks/${id}/comments`, headers: ADMIN });
    expect(first.statusCode).toBe(200);
    const threadId = first.json().data.threadId;
    expect(threadId).toMatch(/^thread_/);
    expect(first.json().data.comments).toEqual([]);

    // The task is now linked.
    const task = await app.inject({ method: "GET", url: `/tasks/${id}`, headers: ADMIN });
    expect(task.json().data.threadId).toBe(threadId);

    // Second read reuses the same thread (idempotent).
    const second = await app.inject({ method: "GET", url: `/tasks/${id}/comments`, headers: ADMIN });
    expect(second.json().data.threadId).toBe(threadId);
  });

  it("posts a comment and reads it back", async () => {
    const issue = await createIssue({ title: "comment me" });
    const id = issue.json().data.id;

    const post = await app.inject({
      method: "POST", url: `/tasks/${id}/comments`, headers: json(ADMIN),
      body: JSON.stringify({ body: "first comment", type: "status" }),
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().data.body).toBe("first comment");
    expect(post.json().data.fromAgent).toBe("human"); // admin path

    const read = await app.inject({ method: "GET", url: `/tasks/${id}/comments`, headers: ADMIN });
    const comments = read.json().data.comments as Array<{ body: string }>;
    expect(comments.map((c) => c.body)).toContain("first comment");
  });

  it("an agent posts a comment under its own identity", async () => {
    const worker = await app.inject({
      method: "POST", url: "/agents", headers: json(ADMIN),
      body: JSON.stringify({ projectId, name: "commenter", role: "worker" }),
    });
    const workerId = worker.json().data.id;
    const workerAuth = { Authorization: `Bearer ${worker.json().token}` };
    const issue = await createIssue({ title: "agent comment", assignedTo: workerId });
    const id = issue.json().data.id;

    const post = await app.inject({
      method: "POST", url: `/tasks/${id}/comments`, headers: json(workerAuth),
      body: JSON.stringify({ body: "on it" }),
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().data.fromAgent).toBe(workerId);
  });

  it("404s comments for an unknown task", async () => {
    const res = await app.inject({ method: "GET", url: "/tasks/task_nope/comments", headers: ADMIN });
    expect(res.statusCode).toBe(404);
  });
});
