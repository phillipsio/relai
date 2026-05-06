import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-session";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}` };

let app: FastifyInstance;
let projectId: string;
let otherProjectId: string;
let agentId: string;
let agentAuth: { Authorization: string };
let otherAgentAuth: { Authorization: string };
let threadId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/projects",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "__test__ session", context: "Read this first." }),
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().data.id;

  const otherProject = await app.inject({
    method: "POST", url: "/projects",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "__test__ session-other" }),
  });
  expect(otherProject.statusCode).toBe(201);
  otherProjectId = otherProject.json().data.id;

  const agent = await app.inject({
    method: "POST", url: "/agents",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, name: "session-test-agent", role: "worker", specialization: "tester" }),
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().data.id;
  agentAuth = { Authorization: `Bearer ${agent.json().token}` };

  const otherAgent = await app.inject({
    method: "POST", url: "/agents",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: otherProjectId, name: "other-agent", role: "worker" }),
  });
  expect(otherAgent.statusCode).toBe(201);
  otherAgentAuth = { Authorization: `Bearer ${otherAgent.json().token}` };

  // A task assigned to me, in_progress.
  await app.inject({
    method: "POST", url: "/tasks",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId, createdBy: agentId, assignedTo: agentId,
      title: "running task", description: "x",
      status: "in_progress",
    }),
  });

  // A completed task — must NOT show up in my tasks bucket.
  await app.inject({
    method: "POST", url: "/tasks",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId, createdBy: agentId, assignedTo: agentId,
      title: "old task", description: "x",
      status: "completed",
    }),
  });

  // A thread + a message addressed to me.
  const thread = await app.inject({
    method: "POST", url: "/threads",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, title: "session test thread" }),
  });
  expect(thread.statusCode).toBe(201);
  threadId = thread.json().data.id;

  await app.inject({
    method: "POST", url: `/threads/${threadId}/messages`,
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      fromAgent: agentId, toAgent: agentId,
      type: "status", body: "hello",
    }),
  });
});

afterAll(async () => {
  for (const pid of [projectId, otherProjectId]) {
    if (!pid) continue;
    try {
      execSync(
        `psql "${DB_URL}" -c "` +
        `DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE project_id = '${pid}'); ` +
        `DELETE FROM threads WHERE project_id = '${pid}'; ` +
        `DELETE FROM tasks WHERE project_id = '${pid}'; ` +
        `DELETE FROM subscriptions WHERE agent_id IN (SELECT id FROM agents WHERE project_id = '${pid}'); ` +
        `DELETE FROM tokens WHERE agent_id IN (SELECT id FROM agents WHERE project_id = '${pid}'); ` +
        `DELETE FROM agents WHERE project_id = '${pid}'; ` +
        `DELETE FROM projects WHERE id = '${pid}';"`,
        { stdio: "pipe" },
      );
    } catch { /* best-effort */ }
  }
  await app?.close();
});

describe("GET /session/start", () => {
  it("returns the bundled snapshot for the calling agent", async () => {
    const res = await app.inject({
      method: "GET", url: `/session/start?projectId=${projectId}`,
      headers: agentAuth,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;

    expect(data.agent.id).toBe(agentId);
    expect(data.agent.specialization).toBe("tester");

    expect(data.project.id).toBe(projectId);
    expect(data.project.context).toBe("Read this first.");

    // Open task only — completed task excluded.
    expect(data.tasks.length).toBe(1);
    expect(data.tasks[0].title).toBe("running task");
    expect(data.tasks[0].humanLabel).toBe("Running");

    // Posting the message auto-subscribed the sender → thread shows up.
    expect(data.openThreads.length).toBe(1);
    expect(data.openThreads[0].id).toBe(threadId);

    // Message addressed to me, not yet marked read.
    expect(data.unreadMessages.length).toBe(1);
    expect(data.unreadMessages[0].body).toBe("hello");

    // Persisted events: at minimum, the message.posted I'm subscribed to.
    // Newest first; capped at 50.
    expect(Array.isArray(data.recentEvents)).toBe(true);
    expect(data.recentEvents.length).toBeGreaterThanOrEqual(1);
    expect(data.recentEvents[0].kind).toBe("message.posted");
    expect(data.recentEvents[0].targetId).toBe(threadId);
  });

  it("defaults projectId to the agent's own project", async () => {
    const res = await app.inject({
      method: "GET", url: "/session/start",
      headers: agentAuth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.project.id).toBe(projectId);
  });

  it("rejects callers from another project", async () => {
    const res = await app.inject({
      method: "GET", url: `/session/start?projectId=${projectId}`,
      headers: otherAgentAuth,
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects the deprecated API_SECRET caller (no agent identity)", async () => {
    const res = await app.inject({
      method: "GET", url: `/session/start?projectId=${projectId}`,
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(403);
  });

  it("requires a bearer token", async () => {
    const res = await app.inject({
      method: "GET", url: `/session/start?projectId=${projectId}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
