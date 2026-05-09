import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { eq, and } from "drizzle-orm";
import { buildServer } from "../../server.js";
import { handleMessage, runMessageLoopCycle } from "./message-loop.js";
import {
  createDb,
  agents as agentsTable,
  messages as messagesTable,
  tasks as tasksTable,
} from "@getrelai/db";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-message-loop";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;
// Tell the messages route to skip its legacy escalation auto-task creation
// — the in-API message loop owns that lifecycle now and these tests assert
// on its behaviour, not the route's fallback.
process.env.ENABLE_MESSAGE_ROUTING = "true";

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

let app: FastifyInstance;
const db = createDb(DB_URL);
let projectId: string;
let orchestratorId: string;
let threadId: string;

function makeAnthropic(action: Record<string, unknown>): Anthropic {
  return {
    messages: {
      create: async () => ({ content: [{ type: "tool_use", input: action }] }),
    },
  } as unknown as Anthropic;
}

async function newAgent(opts: {
  name:           string;
  role:           "worker" | "orchestrator";
  specialization?: string;
  tier?:          number;
  domains?:       string[];
}): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({
      projectId,
      name:           opts.name,
      role:           opts.role,
      specialization: opts.specialization,
      tier:           opts.tier,
      domains:        opts.domains ?? [],
    }),
  });
  const id = res.json().data.id;
  // POST /agents sets lastSeenAt to epoch ("never connected") — bump to now
  // so our tests reflect online agents without each test having to heartbeat.
  await db.update(agentsTable).set({ lastSeenAt: new Date() }).where(eq(agentsTable.id, id));
  return id;
}

async function setLastSeen(agentId: string, msAgo: number): Promise<void> {
  await db.update(agentsTable)
    .set({ lastSeenAt: new Date(Date.now() - msAgo) })
    .where(eq(agentsTable.id, agentId));
}

async function newMessage(opts: {
  type:      "status" | "handoff" | "finding" | "decision" | "question" | "escalation" | "reply";
  fromAgent: string;
  toAgent?:  string;
  body?:     string;
}) {
  const res = await app.inject({
    method: "POST", url: `/threads/${threadId}/messages`, headers: ADMIN,
    body: JSON.stringify({
      fromAgent: opts.fromAgent,
      toAgent:   opts.toAgent,
      type:      opts.type,
      body:      opts.body ?? "Test body",
    }),
  });
  return res.json().data;
}

async function reloadMessage(id: string) {
  const [row] = await db.select().from(messagesTable).where(eq(messagesTable.id, id));
  return row;
}

async function listMessages() {
  return db.select().from(messagesTable)
    .where(eq(messagesTable.threadId, threadId))
    .orderBy(messagesTable.createdAt);
}

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/projects", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ message-loop" }),
  });
  projectId = project.json().data.id;

  orchestratorId = await newAgent({ name: "orch", role: "orchestrator" });

  const thread = await app.inject({
    method: "POST", url: "/threads", headers: ADMIN,
    body: JSON.stringify({ projectId, title: "message-loop test thread" }),
  });
  threadId = thread.json().data.id;
});

afterAll(async () => {
  if (projectId) {
    await app.inject({ method: "DELETE", url: `/projects/${projectId}`, headers: ADMIN });
  }
  await app?.close();
});

beforeEach(async () => {
  // Wipe per-test state: messages on the thread, worker agents, any tasks.
  await db.delete(messagesTable).where(eq(messagesTable.threadId, threadId));
  await db.delete(tasksTable).where(eq(tasksTable.projectId, projectId));
  await db.delete(agentsTable).where(and(eq(agentsTable.projectId, projectId), eq(agentsTable.role, "worker")));
});

async function getOrchestrator() {
  const [row] = await db.select().from(agentsTable).where(eq(agentsTable.id, orchestratorId));
  return row;
}

describe("handleMessage — scope filter", () => {
  it("skips messages sent to a different agent", async () => {
    const otherId = await newAgent({ name: "other", role: "worker" });
    const sender  = await newAgent({ name: "sender", role: "worker" });
    const msg = await newMessage({ type: "status", fromAgent: sender, toAgent: otherId });
    await handleMessage({ db, anthropic: null, model: "test" }, projectId, await getOrchestrator(), msg);
    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).not.toContain(orchestratorId);
  });

  it("skips messages from the orchestrator itself", async () => {
    const msg = await newMessage({ type: "status", fromAgent: orchestratorId });
    await handleMessage({ db, anthropic: null, model: "test" }, projectId, await getOrchestrator(), msg);
    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).not.toContain(orchestratorId);
  });

  it("processes messages addressed to the orchestrator", async () => {
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg = await newMessage({ type: "status", fromAgent: sender, toAgent: orchestratorId });
    await handleMessage({ db, anthropic: null, model: "test" }, projectId, await getOrchestrator(), msg);
    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).toContain(orchestratorId);
  });

  it("processes broadcast messages (toAgent null)", async () => {
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg = await newMessage({ type: "status", fromAgent: sender });
    await handleMessage({ db, anthropic: null, model: "test" }, projectId, await getOrchestrator(), msg);
    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).toContain(orchestratorId);
  });
});

describe("handleMessage — status / reply", () => {
  it("status: marks read with no other side effects", async () => {
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg = await newMessage({ type: "status", fromAgent: sender });

    const beforeMsgs = await listMessages();
    await handleMessage({ db, anthropic: null, model: "test" }, projectId, await getOrchestrator(), msg);
    const afterMsgs = await listMessages();

    expect(afterMsgs.length).toBe(beforeMsgs.length); // no new messages sent
    const taskRows = await db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
    expect(taskRows).toHaveLength(0);
    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).toContain(orchestratorId);
  });

  it("reply: marks read with no other side effects", async () => {
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg = await newMessage({ type: "reply", fromAgent: sender });

    await handleMessage({ db, anthropic: null, model: "test" }, projectId, await getOrchestrator(), msg);

    const taskRows = await db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
    expect(taskRows).toHaveLength(0);
    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).toContain(orchestratorId);
  });
});

describe("handleMessage — escalation", () => {
  it("creates a task for a tier-2 senior agent and replies to the escalating agent", async () => {
    const senior = await newAgent({ name: "senior", role: "worker", tier: 2, specialization: "architect" });
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg    = await newMessage({ type: "escalation", fromAgent: sender, body: "Stuck on auth" });

    await handleMessage({ db, anthropic: null, model: "test" }, projectId, await getOrchestrator(), msg);

    const newTasks = await db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
    expect(newTasks).toHaveLength(1);
    expect(newTasks[0]).toMatchObject({ priority: "high", specialization: "architect", status: "assigned", assignedTo: senior });

    const allMsgs = await listMessages();
    const reply = allMsgs.find((m) => m.fromAgent === orchestratorId && m.type === "reply");
    expect(reply).toBeTruthy();
    expect(reply!.toAgent).toBe(sender);
    expect(reply!.body).toMatch(/escalation received/i);
    expect(reply!.body).toContain(senior);
  });

  it("falls back to 'architect' specialization when no tier-2 agent is set", async () => {
    const arch   = await newAgent({ name: "arch", role: "worker", specialization: "architect" });
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg    = await newMessage({ type: "escalation", fromAgent: sender });

    await handleMessage({ db, anthropic: null, model: "test" }, projectId, await getOrchestrator(), msg);

    const newTasks = await db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
    expect(newTasks).toHaveLength(1);
    expect(newTasks[0].assignedTo).toBe(arch);
  });

  it("surfaces to human when no senior agent is available", async () => {
    const junior = await newAgent({ name: "junior", role: "worker", tier: 1 });
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg    = await newMessage({ type: "escalation", fromAgent: sender });

    await handleMessage({ db, anthropic: null, model: "test" }, projectId, await getOrchestrator(), msg);

    const newTasks = await db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
    expect(newTasks).toHaveLength(0);
    expect(junior).toBeTruthy(); // referenced so lint doesn't strip

    const reply = (await listMessages()).find((m) => m.fromAgent === orchestratorId && m.type === "reply");
    expect(reply).toBeTruthy();
    expect(reply!.body).toMatch(/no senior agent/i);
    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).toContain(orchestratorId);
  });
});

describe("handleMessage — decision", () => {
  it("broadcasts to all online workers and skips stale ones", async () => {
    const a1     = await newAgent({ name: "a1", role: "worker" });
    const a2     = await newAgent({ name: "a2", role: "worker" });
    const stale  = await newAgent({ name: "stale", role: "worker" });
    await setLastSeen(stale, 11 * 60 * 1000);
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg    = await newMessage({ type: "decision", fromAgent: sender, body: "Use JWT" });

    await handleMessage({ db, anthropic: null, model: "test" }, projectId, await getOrchestrator(), msg);

    const broadcasted = (await listMessages()).filter((m) => m.fromAgent === orchestratorId && m.type === "decision");
    const recipients = new Set(broadcasted.map((m) => m.toAgent));
    expect(recipients.has(a1)).toBe(true);
    expect(recipients.has(a2)).toBe(true);
    expect(recipients.has(stale)).toBe(false);
    expect(recipients.has(sender)).toBe(true); // sender is online too — broadcast hits everyone online

    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).toContain(orchestratorId);
  });

  it("marks read even when no workers are online", async () => {
    const sender = await newAgent({ name: "sender", role: "worker" });
    await setLastSeen(sender, 11 * 60 * 1000);
    const msg = await newMessage({ type: "decision", fromAgent: sender });

    await handleMessage({ db, anthropic: null, model: "test" }, projectId, await getOrchestrator(), msg);

    const broadcasts = (await listMessages())
      .filter((m) => m.fromAgent === orchestratorId && m.type === "decision");
    expect(broadcasts).toHaveLength(0);
    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).toContain(orchestratorId);
  });
});

describe("handleMessage — handoff", () => {
  it("creates a task from Claude's create_task action", async () => {
    await newAgent({ name: "writer", role: "worker", specialization: "writer" });
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg = await newMessage({ type: "handoff", fromAgent: sender });

    const ai = makeAnthropic({
      action: "create_task",
      taskTitle: "Implement auth endpoints",
      taskDescription: "Build POST /auth/login per spec",
      taskDomains: ["typescript", "api"],
      taskSpecialization: "writer",
      taskPriority: "high",
    });
    await handleMessage({ db, anthropic: ai, model: "test" }, projectId, await getOrchestrator(), msg);

    const created = await db.select().from(tasksTable)
      .where(and(eq(tasksTable.projectId, projectId), eq(tasksTable.title, "Implement auth endpoints")));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ priority: "high", specialization: "writer", domains: ["typescript", "api"], createdBy: orchestratorId });

    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).toContain(orchestratorId);
  });

  it("forwards to a specific agent on Claude's forward action", async () => {
    const target = await newAgent({ name: "target", role: "worker" });
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg = await newMessage({ type: "handoff", fromAgent: sender });

    const ai = makeAnthropic({ action: "forward", toAgent: target, messageBody: "Please handle this." });
    await handleMessage({ db, anthropic: ai, model: "test" }, projectId, await getOrchestrator(), msg);

    const forwards = (await listMessages())
      .filter((m) => m.fromAgent === orchestratorId && m.toAgent === target && m.type === "handoff");
    expect(forwards).toHaveLength(1);
    expect(forwards[0].body).toBe("Please handle this.");

    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).toContain(orchestratorId);
  });
});

describe("handleMessage — question", () => {
  it("sends a reply on Claude's reply action", async () => {
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg = await newMessage({ type: "question", fromAgent: sender, body: "Which JWT lib?" });

    const ai = makeAnthropic({ action: "reply", messageBody: "Use jose with 15min expiry." });
    await handleMessage({ db, anthropic: ai, model: "test" }, projectId, await getOrchestrator(), msg);

    const reply = (await listMessages())
      .find((m) => m.fromAgent === orchestratorId && m.type === "reply" && m.toAgent === sender);
    expect(reply).toBeTruthy();
    expect(reply!.body).toBe("Use jose with 15min expiry.");

    const reloaded = await reloadMessage(msg.id);
    expect(reloaded.readBy).toContain(orchestratorId);
  });

  it("forwards to a specialist on Claude's forward action", async () => {
    const specialist = await newAgent({ name: "specialist", role: "worker", specialization: "auth" });
    const sender     = await newAgent({ name: "sender", role: "worker" });
    const msg = await newMessage({ type: "question", fromAgent: sender });

    const ai = makeAnthropic({ action: "forward", toAgent: specialist, messageBody: "Can you take this?" });
    await handleMessage({ db, anthropic: ai, model: "test" }, projectId, await getOrchestrator(), msg);

    const forwards = (await listMessages())
      .filter((m) => m.fromAgent === orchestratorId && m.toAgent === specialist && m.type === "question");
    expect(forwards).toHaveLength(1);
  });
});

describe("handleMessage — finding", () => {
  it("creates a task on Claude's create_task action", async () => {
    await newAgent({ name: "fixer", role: "worker" });
    const sender = await newAgent({ name: "sender", role: "worker" });
    const msg = await newMessage({ type: "finding", fromAgent: sender, body: "SQL injection" });

    const ai = makeAnthropic({
      action: "create_task",
      taskTitle: "Fix security issue",
      taskDescription: "SQL injection in search endpoint",
      taskDomains: ["api", "security"],
      taskPriority: "urgent",
    });
    await handleMessage({ db, anthropic: ai, model: "test" }, projectId, await getOrchestrator(), msg);

    const created = await db.select().from(tasksTable)
      .where(and(eq(tasksTable.projectId, projectId), eq(tasksTable.title, "Fix security issue")));
    expect(created).toHaveLength(1);
    expect(created[0].priority).toBe("urgent");
  });
});

describe("runMessageLoopCycle", () => {
  it("processes the orchestrator's project-wide unread messages", async () => {
    const sender = await newAgent({ name: "sender", role: "worker" });
    await newMessage({ type: "status", fromAgent: sender });
    await newMessage({ type: "status", fromAgent: sender });

    await runMessageLoopCycle({ db, anthropic: null, model: "test" }, projectId);

    const allMsgs = await listMessages();
    for (const m of allMsgs.filter((x) => x.fromAgent !== orchestratorId)) {
      expect(m.readBy).toContain(orchestratorId);
    }
  });

  it("is a no-op for projects without an orchestrator agent", async () => {
    // Spin a fresh project that has no orchestrator
    const otherProject = await app.inject({
      method: "POST", url: "/projects", headers: ADMIN,
      body: JSON.stringify({ name: "__test__ no-orch" }),
    });
    const otherProjectId = otherProject.json().data.id;
    try {
      await expect(
        runMessageLoopCycle({ db, anthropic: null, model: "test" }, otherProjectId),
      ).resolves.not.toThrow();
    } finally {
      await app.inject({ method: "DELETE", url: `/projects/${otherProjectId}`, headers: ADMIN });
    }
  });
});

