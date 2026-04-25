import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMessage } from "./message-loop.js";
import type { OrchestratorApiClient, MessageRow, AgentRow } from "./api-client.js";
import type { OrchestratorConfig } from "./config.js";

const ORCHESTRATOR_ID = "agent_orch";
const PROJECT_ID = "proj_test";
const THREAD_ID = "thread_1";
const now = new Date().toISOString();
const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();

function mockConfig(): OrchestratorConfig {
  return {
    apiUrl: "http://localhost:3010",
    apiSecret: "secret",
    agentId: ORCHESTRATOR_ID,
    projectId: PROJECT_ID,
    anthropicApiKey: "test",
    model: "claude-opus-4-6",
    pollIntervalMs: 15_000,
    escalationIntervalMs: 30_000,
    heartbeatIntervalMs: 60_000,
    messageIntervalMs: 10_000,
    blockedWatchIntervalMs: 15_000,
    maxTaskRounds: 5,
  };
}

function agent(id: string, opts: Partial<AgentRow> = {}): AgentRow {
  return { id, name: id, role: "worker", domains: [], specialization: null, lastSeenAt: now, ...opts };
}

function message(type: MessageRow["type"], opts: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg_1",
    threadId: THREAD_ID,
    fromAgent: "agent_sender",
    toAgent: undefined,
    type,
    body: "Test message body",
    metadata: {},
    createdAt: now,
    ...opts,
  };
}

function mockClient(overrides: Partial<OrchestratorApiClient> = {}): OrchestratorApiClient {
  return {
    getPendingTasks: vi.fn().mockResolvedValue([]),
    assignTask: vi.fn().mockResolvedValue({}),
    getWorkerAgents: vi.fn().mockResolvedValue([]),
    getActiveTaskCounts: vi.fn().mockResolvedValue({}),
    getUnreadEscalations: vi.fn().mockResolvedValue([]),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg_new" }),
    createTask: vi.fn().mockResolvedValue({ id: "task_new" }),
    markRead: vi.fn().mockResolvedValue({}),
    heartbeat: vi.fn().mockResolvedValue({}),
    logRouting: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as OrchestratorApiClient;
}

// Stub Anthropic client — returns a forced tool_use block
function mockAnthropic(action: Record<string, unknown>) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "tool_use", input: action }],
      }),
    },
  } as any;
}

describe("handleMessage — scope filter", () => {
  it("skips messages sent to a different agent", async () => {
    const client = mockClient();
    const msg = message("status", { toAgent: "agent_other" });
    await handleMessage(msg, client, mockAnthropic({}), mockConfig());
    expect(client.markRead).not.toHaveBeenCalled();
  });

  it("skips messages from self", async () => {
    const client = mockClient();
    const msg = message("status", { fromAgent: ORCHESTRATOR_ID });
    await handleMessage(msg, client, mockAnthropic({}), mockConfig());
    expect(client.markRead).not.toHaveBeenCalled();
  });

  it("processes messages addressed to the orchestrator", async () => {
    const client = mockClient();
    const msg = message("status", { toAgent: ORCHESTRATOR_ID });
    await handleMessage(msg, client, mockAnthropic({}), mockConfig());
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
  });

  it("processes broadcast messages (toAgent null)", async () => {
    const client = mockClient();
    const msg = message("status", { toAgent: undefined });
    await handleMessage(msg, client, mockAnthropic({}), mockConfig());
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
  });
});

describe("handleMessage — status", () => {
  it("marks read without sending a message or creating a task", async () => {
    const client = mockClient();
    await handleMessage(message("status"), client, mockAnthropic({}), mockConfig());
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.createTask).not.toHaveBeenCalled();
  });
});

describe("handleMessage — reply", () => {
  it("marks read without sending a message or creating a task", async () => {
    const client = mockClient();
    await handleMessage(message("reply"), client, mockAnthropic({}), mockConfig());
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.createTask).not.toHaveBeenCalled();
  });
});

describe("handleMessage — escalation", () => {
  it("creates a task for a tier-2 senior agent and replies to the escalating agent", async () => {
    const senior = agent("a_senior", { tier: 2, specialization: "architect" });
    const client = mockClient({
      getWorkerAgents: vi.fn().mockResolvedValue([senior]),
      getActiveTaskCounts: vi.fn().mockResolvedValue({}),
    });
    await handleMessage(message("escalation"), client, mockAnthropic({}), mockConfig());
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ specialization: "architect", priority: "high" }),
    );
    expect(client.assignTask).toHaveBeenCalledWith("task_new", "a_senior");
    expect(client.sendMessage).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ type: "reply", toAgent: "agent_sender" }),
    );
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
  });

  it("falls back to 'architect' specialization when no tier-2 agent is set", async () => {
    const architect = agent("a_arch", { specialization: "architect" });
    const client = mockClient({
      getWorkerAgents: vi.fn().mockResolvedValue([architect]),
      getActiveTaskCounts: vi.fn().mockResolvedValue({}),
    });
    await handleMessage(message("escalation"), client, mockAnthropic({}), mockConfig());
    expect(client.createTask).toHaveBeenCalled();
    expect(client.assignTask).toHaveBeenCalledWith("task_new", "a_arch");
  });

  it("surfaces to human when no senior agent is available", async () => {
    const client = mockClient({
      getWorkerAgents: vi.fn().mockResolvedValue([agent("a1", { tier: 1 })]),
      getActiveTaskCounts: vi.fn().mockResolvedValue({}),
    });
    await handleMessage(message("escalation"), client, mockAnthropic({}), mockConfig());
    expect(client.createTask).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ type: "reply", body: expect.stringMatching(/no senior agent/i) }),
    );
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
  });
});

describe("handleMessage — decision", () => {
  it("broadcasts to all online agents and marks read", async () => {
    const agents = [agent("a1"), agent("a2"), agent("a3", { lastSeenAt: stale })];
    const client = mockClient({ getWorkerAgents: vi.fn().mockResolvedValue(agents) });
    await handleMessage(message("decision"), client, mockAnthropic({}), mockConfig());
    // Should send to a1 and a2 (online), not a3 (stale)
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ toAgent: "a1", type: "decision" }),
    );
    expect(client.sendMessage).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ toAgent: "a2", type: "decision" }),
    );
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
  });

  it("marks read even when no agents are online", async () => {
    const client = mockClient({ getWorkerAgents: vi.fn().mockResolvedValue([]) });
    await handleMessage(message("decision"), client, mockAnthropic({}), mockConfig());
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
  });
});

describe("handleMessage — handoff", () => {
  it("creates a task from Claude's extracted details", async () => {
    const client = mockClient({ getWorkerAgents: vi.fn().mockResolvedValue([agent("a1")]) });
    const claudeAction = {
      action: "create_task",
      taskTitle: "Implement auth endpoints",
      taskDescription: "Build POST /auth/login, /auth/refresh, /auth/logout per spec",
      taskDomains: ["typescript", "api"],
      taskSpecialization: "writer",
      taskPriority: "high",
    };
    const anthropic = mockAnthropic(claudeAction);
    await handleMessage(message("handoff"), client, anthropic, mockConfig());
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Implement auth endpoints",
        projectId: PROJECT_ID,
        createdBy: ORCHESTRATOR_ID,
        domains: ["typescript", "api"],
        specialization: "writer",
        priority: "high",
      }),
    );
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
  });

  it("forwards to a specific agent when Claude returns forward action", async () => {
    const client = mockClient({ getWorkerAgents: vi.fn().mockResolvedValue([agent("a1")]) });
    const claudeAction = { action: "forward", toAgent: "a1", messageBody: "Please handle this." };
    const anthropic = mockAnthropic(claudeAction);
    await handleMessage(message("handoff"), client, anthropic, mockConfig());
    expect(client.sendMessage).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ toAgent: "a1", type: "handoff" }),
    );
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
  });
});

describe("handleMessage — question", () => {
  it("sends a reply when Claude returns reply action", async () => {
    const client = mockClient({ getWorkerAgents: vi.fn().mockResolvedValue([]) });
    const claudeAction = { action: "reply", messageBody: "Use JWT with 15min expiry." };
    const anthropic = mockAnthropic(claudeAction);
    await handleMessage(message("question"), client, anthropic, mockConfig());
    expect(client.sendMessage).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({
        type: "reply",
        fromAgent: ORCHESTRATOR_ID,
        body: "Use JWT with 15min expiry.",
      }),
    );
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
  });

  it("forwards to specialist agent when Claude returns forward action", async () => {
    const client = mockClient({ getWorkerAgents: vi.fn().mockResolvedValue([agent("a1")]) });
    const claudeAction = { action: "forward", toAgent: "a1", messageBody: "Can you help with this?" };
    const anthropic = mockAnthropic(claudeAction);
    await handleMessage(message("question"), client, anthropic, mockConfig());
    expect(client.sendMessage).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ toAgent: "a1", type: "question" }),
    );
  });
});

describe("handleMessage — finding", () => {
  it("creates a task when Claude returns create_task action", async () => {
    const client = mockClient({ getWorkerAgents: vi.fn().mockResolvedValue([agent("a1")]) });
    const claudeAction = {
      action: "create_task",
      taskTitle: "Fix security issue",
      taskDescription: "SQL injection vulnerability found in search endpoint",
      taskDomains: ["api", "security"],
      taskPriority: "urgent",
    };
    const anthropic = mockAnthropic(claudeAction);
    await handleMessage(message("finding"), client, anthropic, mockConfig());
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fix security issue", priority: "urgent" }),
    );
    expect(client.markRead).toHaveBeenCalledWith(THREAD_ID, ORCHESTRATOR_ID);
  });
});
