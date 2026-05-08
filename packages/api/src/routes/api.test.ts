import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

// ── env setup ─────────────────────────────────────────────────────────────────
// Requires a running postgres instance at DATABASE_URL (docker-compose default:
//   postgresql://relai:relai@localhost:5433/relai)
const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-abc123";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const AUTH = { Authorization: `Bearer ${SECRET}` };

// ── shared state ──────────────────────────────────────────────────────────────
let app: FastifyInstance;
let projectId: string;
let agentId: string;
let taskId: string;
let threadId: string;

beforeAll(async () => {
  app = buildServer({ logger: false });
  await app.ready();

  // Seed a test project to anchor all test data.
  const res = await app.inject({
    method: "POST", url: "/projects",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "__test__ api-routes", description: "vitest cleanup target" }),
  });
  expect(res.statusCode).toBe(201);
  projectId = res.json().data.id;
});

afterAll(async () => {
  if (projectId) {
    await app.inject({ method: "DELETE", url: `/projects/${projectId}`, headers: AUTH });
  }
  await app?.close();
});

// ── /health ───────────────────────────────────────────────────────────────────
describe("GET /health", () => {
  it("returns ok with auth", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

// ── auth ──────────────────────────────────────────────────────────────────────
describe("auth", () => {
  it("rejects requests with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/agents" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects requests with wrong token", async () => {
    const res = await app.inject({
      method: "GET", url: "/agents",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── projects ──────────────────────────────────────────────────────────────────
describe("POST /projects", () => {
  it("rejects missing name", async () => {
    const res = await app.inject({
      method: "POST", url: "/projects",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ description: "no name" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});

describe("GET /projects", () => {
  it("returns all projects including the test project", async () => {
    const res = await app.inject({ method: "GET", url: "/projects", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ id: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((p) => p.id === projectId)).toBe(true);
  });
});

describe("GET /projects/:id", () => {
  it("returns the test project", async () => {
    const res = await app.inject({
      method: "GET", url: `/projects/${projectId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(projectId);
    expect(res.json().data.name).toBe("__test__ api-routes");
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.inject({
      method: "GET", url: "/projects/proj_nonexistent",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PUT /projects/:id", () => {
  it("updates the pinned context blob", async () => {
    const res = await app.inject({
      method: "PUT", url: `/projects/${projectId}`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ context: "Local Postgres on 5433. Use the WSL venv. Don't run db:push during a rename." }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.context).toContain("Local Postgres on 5433");
  });

  it("clears context when set to null", async () => {
    const res = await app.inject({
      method: "PUT", url: `/projects/${projectId}`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ context: null }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.context).toBeNull();
  });
});

// ── agents ────────────────────────────────────────────────────────────────────
describe("POST /agents", () => {
  it("creates an agent and stores agentId for later tests", async () => {
    const res = await app.inject({
      method: "POST", url: "/agents",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        name: "test-worker",
        role: "worker",
        specialization: "tester",
        domains: ["typescript", "vitest"],
      }),
    });
    expect(res.statusCode).toBe(201);
    const agent = res.json().data;
    expect(agent.name).toBe("test-worker");
    expect(agent.role).toBe("worker");
    expect(agent.specialization).toBe("tester");
    expect(agent.domains).toEqual(["typescript", "vitest"]);
    agentId = agent.id;
  });

  it("rejects invalid role", async () => {
    const res = await app.inject({
      method: "POST", url: "/agents",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, name: "bad", role: "janitor" }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PUT /agents/:id/heartbeat", () => {
  it("updates lastSeenAt", async () => {
    const res = await app.inject({
      method: "PUT", url: `/agents/${agentId}/heartbeat`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(agentId);
  });

  it("returns 404 for unknown agent", async () => {
    const res = await app.inject({
      method: "PUT", url: "/agents/agent_nonexistent/heartbeat",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /agents", () => {
  it("returns agents filtered by projectId", async () => {
    const res = await app.inject({
      method: "GET", url: `/agents?projectId=${projectId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ id: string }>;
    expect(data.some((a) => a.id === agentId)).toBe(true);
  });
});

// ── tasks ─────────────────────────────────────────────────────────────────────
describe("POST /tasks", () => {
  it("creates a task and stores taskId for later tests", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        createdBy: agentId,
        title: "Write vitest integration tests",
        description: "Cover all API routes with inject()",
        priority: "high",
        domains: ["typescript", "vitest"],
        specialization: "tester",
      }),
    });
    expect(res.statusCode).toBe(201);
    const task = res.json().data;
    expect(task.title).toBe("Write vitest integration tests");
    expect(task.status).toBe("pending");
    expect(task.priority).toBe("high");
    expect(task.specialization).toBe("tester");
    expect(task.domains).toEqual(["typescript", "vitest"]);
    taskId = task.id;
  });

  it("rejects missing description", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, createdBy: agentId, title: "no desc" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("flags task for auto-routing when assignedTo='@auto'", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId, createdBy: agentId,
        title: "auto routed", description: "auto routed",
        assignedTo: "@auto",
      }),
    });
    expect(res.statusCode).toBe(201);
    const task = res.json().data;
    expect(task.autoAssign).toBe(true);
    expect(task.assignedTo).toBeNull();
    expect(task.status).toBe("pending");
  });

  it("falls back to project's defaultAssignee when assignee is omitted", async () => {
    // create a project with defaultAssignee="@auto"
    const proj = await app.inject({
      method: "POST", url: "/projects",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "__test__ auto-default", defaultAssignee: "@auto" }),
    });
    expect(proj.statusCode).toBe(201);
    const autoProjectId = proj.json().data.id;

    const res = await app.inject({
      method: "POST", url: "/tasks",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: autoProjectId, createdBy: agentId,
        title: "inherits @auto", description: "inherits @auto",
      }),
    });
    expect(res.statusCode).toBe(201);
    const task = res.json().data;
    expect(task.autoAssign).toBe(true);
    expect(task.assignedTo).toBeNull();
    expect(task.status).toBe("pending");

    // cleanup
    await app.inject({ method: "DELETE", url: `/projects/${autoProjectId}`, headers: AUTH });
  });
});

describe("GET /tasks", () => {
  it("returns tasks filtered by projectId", async () => {
    const res = await app.inject({
      method: "GET", url: `/tasks?projectId=${projectId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ id: string }>;
    expect(data.some((t) => t.id === taskId)).toBe(true);
  });

  it("filters by status=pending", async () => {
    const res = await app.inject({
      method: "GET", url: `/tasks?projectId=${projectId}&status=pending`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ id: string; status: string }>;
    expect(data.every((t) => t.status === "pending")).toBe(true);
    expect(data.some((t) => t.id === taskId)).toBe(true);
  });

  it("returns no test task for status=completed", async () => {
    const res = await app.inject({
      method: "GET", url: `/tasks?projectId=${projectId}&status=completed`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ id: string }>;
    expect(data.some((t) => t.id === taskId)).toBe(false);
  });

  it("filters by assignedTo", async () => {
    // Task is unassigned, so filtering by agentId should return nothing yet.
    const res = await app.inject({
      method: "GET", url: `/tasks?projectId=${projectId}&assignedTo=${agentId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ id: string }>;
    expect(data.some((t) => t.id === taskId)).toBe(false);
  });
});

describe("GET /tasks/:id", () => {
  it("returns the task", async () => {
    const res = await app.inject({
      method: "GET", url: `/tasks/${taskId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(taskId);
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.inject({
      method: "GET", url: "/tasks/task_nonexistent",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PUT /tasks/:id", () => {
  it("assigns and starts the task", async () => {
    const res = await app.inject({
      method: "PUT", url: `/tasks/${taskId}`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress", assignedTo: agentId }),
    });
    expect(res.statusCode).toBe(200);
    const task = res.json().data;
    expect(task.status).toBe("in_progress");
    expect(task.assignedTo).toBe(agentId);
  });

  it("completes the task", async () => {
    const res = await app.inject({
      method: "PUT", url: `/tasks/${taskId}`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("completed");
  });

  it("rejects invalid status value", async () => {
    const res = await app.inject({
      method: "PUT", url: `/tasks/${taskId}`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "flying" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for unknown task id", async () => {
    const res = await app.inject({
      method: "PUT", url: "/tasks/task_nonexistent",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("rewrites completed → pending_verification when verifyCommand is set", async () => {
    const create = await app.inject({
      method: "POST", url: "/tasks",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        createdBy: agentId,
        title: "verified task",
        description: "needs predicate",
        verifyCommand: "true",
      }),
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().data.id;
    expect(create.json().data.verifyCommand).toBe("true");

    const done = await app.inject({
      method: "PUT", url: `/tasks/${id}`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().data.status).toBe("pending_verification");
  });

  it("persists verifyTimeoutMs on POST /tasks within bounds", async () => {
    const create = await app.inject({
      method: "POST", url: "/tasks",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        createdBy: agentId,
        title: "timed verify",
        description: "long-running predicate",
        verifyCommand:   "true",
        verifyTimeoutMs: 120_000,
      }),
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().data.verifyTimeoutMs).toBe(120_000);
  });

  it("rejects verifyTimeoutMs outside [1s, 10min]", async () => {
    const tooShort = await app.inject({
      method: "POST", url: "/tasks",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId, createdBy: agentId, title: "x", description: "x",
        verifyCommand: "true", verifyTimeoutMs: 500,
      }),
    });
    expect(tooShort.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: "POST", url: "/tasks",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId, createdBy: agentId, title: "x", description: "x",
        verifyCommand: "true", verifyTimeoutMs: 700_000,
      }),
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("leaves completed alone when no verifyCommand", async () => {
    const create = await app.inject({
      method: "POST", url: "/tasks",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        createdBy: agentId,
        title: "ungated task",
        description: "no predicate",
      }),
    });
    const id = create.json().data.id;

    const done = await app.inject({
      method: "PUT", url: `/tasks/${id}`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(done.json().data.status).toBe("completed");
  });
});

// ── routing-log ───────────────────────────────────────────────────────────────
describe("POST /routing-log", () => {
  it("creates a rules-based routing entry", async () => {
    const res = await app.inject({
      method: "POST", url: "/routing-log",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId:     taskId,
        assignedTo: agentId,
        method:     "rules",
        rationale:  "Exact domain match: agent owns [typescript, vitest]",
      }),
    });
    expect(res.statusCode).toBe(201);
    const entry = res.json().data;
    expect(entry.taskId).toBe(taskId);
    expect(entry.assignedTo).toBe(agentId);
    expect(entry.method).toBe("rules");
    expect(entry.rationale).toMatch(/exact domain match/i);
    expect(entry.id).toMatch(/^rlog_/);
  });

  it("creates a claude-based routing entry", async () => {
    const res = await app.inject({
      method: "POST", url: "/routing-log",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId:     taskId,
        assignedTo: agentId,
        method:     "claude",
        rationale:  "Selected based on expertise in testing frameworks",
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.method).toBe("claude");
  });

  it("rejects invalid method value", async () => {
    const res = await app.inject({
      method: "POST", url: "/routing-log",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId:     taskId,
        assignedTo: agentId,
        method:     "magic",
        rationale:  "trust me",
      }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /routing-log", () => {
  it("filters by taskId", async () => {
    const res = await app.inject({
      method: "GET", url: `/routing-log?taskId=${taskId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ taskId: string }>;
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data.every((e) => e.taskId === taskId)).toBe(true);
  });

  it("filters by assignedTo", async () => {
    const res = await app.inject({
      method: "GET", url: `/routing-log?assignedTo=${agentId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ assignedTo: string }>;
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data.every((e) => e.assignedTo === agentId)).toBe(true);
  });
});

// ── threads ───────────────────────────────────────────────────────────────────
describe("POST /threads", () => {
  it("creates a thread and stores threadId for later tests", async () => {
    const res = await app.inject({
      method: "POST", url: "/threads",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "Auth design discussion" }),
    });
    expect(res.statusCode).toBe(201);
    const thread = res.json().data;
    expect(thread.title).toBe("Auth design discussion");
    expect(thread.projectId).toBe(projectId);
    expect(thread.id).toMatch(/^thread_/);
    threadId = thread.id;
  });

  it("rejects missing title", async () => {
    const res = await app.inject({
      method: "POST", url: "/threads",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /threads", () => {
  it("returns threads filtered by projectId", async () => {
    const res = await app.inject({
      method: "GET", url: `/threads?projectId=${projectId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ id: string }>;
    expect(data.some((t) => t.id === threadId)).toBe(true);
  });
});

// ── messages ──────────────────────────────────────────────────────────────────
describe("POST /threads/:id/messages", () => {
  it("posts a handoff message", async () => {
    const res = await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        fromAgent: agentId,
        type: "handoff",
        body: "Auth spec drafted — passing to reviewer",
        metadata: { taskId },
      }),
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json().data;
    expect(msg.threadId).toBe(threadId);
    expect(msg.fromAgent).toBe(agentId);
    expect(msg.type).toBe("handoff");
    expect(msg.readBy).toEqual([]);
    expect(msg.id).toMatch(/^msg_/);
  });

  it("posts a status message with toAgent", async () => {
    const res = await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        fromAgent: agentId,
        toAgent: agentId,
        type: "status",
        body: "In progress",
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.toAgent).toBe(agentId);
  });

  it("rejects invalid message type", async () => {
    const res = await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ fromAgent: agentId, type: "shout", body: "hey" }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /threads/:id/messages", () => {
  it("returns messages for the thread", async () => {
    const res = await app.inject({
      method: "GET", url: `/threads/${threadId}/messages`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ threadId: string }>;
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data.every((m) => m.threadId === threadId)).toBe(true);
  });
});

describe("GET /messages/unread", () => {
  it("returns unread messages scoped to the project", async () => {
    const res = await app.inject({
      method: "GET", url: `/messages/unread?agentId=${agentId}&projectId=${projectId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ readBy: string[] }>;
    expect(data.every((m) => !m.readBy.includes(agentId))).toBe(true);
  });

  it("requires agentId query param", async () => {
    const res = await app.inject({
      method: "GET", url: `/messages/unread?projectId=${projectId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires projectId query param", async () => {
    const res = await app.inject({
      method: "GET", url: `/messages/unread?agentId=${agentId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PUT /threads/:id/messages/read", () => {
  it("marks all messages in thread as read", async () => {
    const res = await app.inject({
      method: "PUT", url: `/threads/${threadId}/messages/read`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    // Verify messages now appear as read
    const msgs = await app.inject({
      method: "GET", url: `/threads/${threadId}/messages`,
      headers: AUTH,
    });
    const data = msgs.json().data as Array<{ readBy: string[] }>;
    expect(data.every((m) => m.readBy.includes(agentId))).toBe(true);
  });

  it("requires agentId in body", async () => {
    const res = await app.inject({
      method: "PUT", url: `/threads/${threadId}/messages/read`,
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });
});
