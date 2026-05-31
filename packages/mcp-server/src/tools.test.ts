import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTools } from "./tools.js";
import type { ApiClient } from "./api-client.js";

const AGENT_ID = "agent_test";
const PROJECT_ID = "proj_test";

function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue({}),
    createTask: vi.fn().mockResolvedValue({}),
    updateTask: vi.fn().mockResolvedValue({ id: "task_1", status: "in_progress" }),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg_1", type: "status" }),
    getMessages: vi.fn().mockResolvedValue([]),
    getUnread: vi.fn().mockResolvedValue([]),
    markRead: vi.fn().mockResolvedValue({}),
    registerAgent: vi.fn().mockResolvedValue({}),
    heartbeat: vi.fn().mockResolvedValue({}),
    listAgents: vi.fn().mockResolvedValue([]),
    createThread: vi.fn().mockResolvedValue({ id: "thread_1", title: "test" }),
    listThreads: vi.fn().mockResolvedValue([]),
    submitReview: vi.fn().mockResolvedValue({ id: "task_1", status: "pending_verification" }),
    commitTask: vi.fn().mockResolvedValue({ id: "task_1", status: "assigned" }),
    concludePlan: vi.fn().mockResolvedValue({}),
    getSessionStart: vi.fn().mockResolvedValue({
      agent: { id: AGENT_ID, name: "test", specialization: null, workerType: null, repoPath: null },
      project: { id: PROJECT_ID, name: "test", context: null, defaultAssignee: null },
      tasks: [], unreadMessages: [], openThreads: [],
    }),
    ...overrides,
  } as unknown as ApiClient;
}

function getHandler(tools: ReturnType<typeof buildTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool.handler;
}

describe("buildTools", () => {
  it("returns all 13 tools", () => {
    const tools = buildTools(mockClient(), AGENT_ID, PROJECT_ID);
    expect(tools).toHaveLength(13);
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_task");
    expect(names).toContain("commit_task");
    expect(names).toContain("get_my_tasks");
    expect(names).toContain("update_task_status");
    expect(names).toContain("send_message");
    expect(names).toContain("get_unread_messages");
    expect(names).toContain("mark_thread_read");
    expect(names).toContain("list_threads");
    expect(names).toContain("create_thread");
    expect(names).toContain("conclude_plan");
    expect(names).toContain("list_all_tasks");
    expect(names).toContain("session_start");
    expect(names).toContain("submit_review");
  });
});

describe("submit_review", () => {
  it("forwards decision and note to submitReview and returns MCP content", async () => {
    const submit = vi.fn().mockResolvedValue({ id: "task_42", status: "pending_verification" });
    const tools = buildTools(mockClient({ submitReview: submit }), AGENT_ID, PROJECT_ID);
    const result = await getHandler(tools, "submit_review")({ taskId: "task_42", decision: "reject", note: "needs tests" });
    expect(submit).toHaveBeenCalledWith("task_42", { decision: "reject", note: "needs tests" });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("task_42");
  });
});

describe("commit_task", () => {
  it("forwards assignee and edits to commitTask and returns MCP content", async () => {
    const commit = vi.fn().mockResolvedValue({ id: "task_42", status: "assigned" });
    const tools = buildTools(mockClient({ commitTask: commit }), AGENT_ID, PROJECT_ID);
    const result = await getHandler(tools, "commit_task")({ taskId: "task_42", assignedTo: "@auto", priority: "high" });
    expect(commit).toHaveBeenCalledWith("task_42", { decision: "commit", assignedTo: "@auto", priority: "high" });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("task_42");
  });

  it("forwards a reject decision", async () => {
    const commit = vi.fn().mockResolvedValue({ id: "task_42", status: "cancelled" });
    const tools = buildTools(mockClient({ commitTask: commit }), AGENT_ID, PROJECT_ID);
    await getHandler(tools, "commit_task")({ taskId: "task_42", decision: "reject", note: "out of scope" });
    expect(commit).toHaveBeenCalledWith("task_42", { decision: "reject", note: "out of scope" });
  });
});

describe("session_start", () => {
  it("calls getSessionStart with the configured projectId and returns text content", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "session_start");
    const result = await (handler as Function)({});
    expect(client.getSessionStart).toHaveBeenCalledWith(PROJECT_ID);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.agent.id).toBe(AGENT_ID);
    expect(parsed.project.id).toBe(PROJECT_ID);
  });
});

describe("get_my_tasks", () => {
  it("defaults to status=assigned when no input provided", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "get_my_tasks");
    await (handler as Function)({});
    expect(client.getTasks).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      assignedTo: AGENT_ID,
      status: "assigned",
    });
  });

  it("passes explicit status through", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "get_my_tasks");
    await (handler as Function)({ status: "in_progress" });
    expect(client.getTasks).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      assignedTo: AGENT_ID,
      status: "in_progress",
    });
  });

  it("passes undefined status when 'all' is requested", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "get_my_tasks");
    await (handler as Function)({ status: "all" });
    expect(client.getTasks).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      assignedTo: AGENT_ID,
      status: undefined,
    });
  });

  it("returns MCP content format", async () => {
    const task = { id: "task_1", title: "Test task", status: "assigned" };
    const client = mockClient({ getTasks: vi.fn().mockResolvedValue([task]) });
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "get_my_tasks");
    const result = await (handler as Function)({});
    expect(result).toHaveProperty("content");
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("task_1");
  });

  it("returns empty message text when no tasks found", async () => {
    const handler = getHandler(buildTools(mockClient(), AGENT_ID, PROJECT_ID), "get_my_tasks");
    const result = await (handler as Function)({});
    expect(result.content[0].text).toBe("No tasks currently match that filter.");
  });
});

describe("update_task_status", () => {
  it("calls updateTask with correct args", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "update_task_status");
    await (handler as Function)({ taskId: "task_1", status: "in_progress" });
    expect(client.updateTask).toHaveBeenCalledWith("task_1", {
      status: "in_progress",
      metadata: undefined,
    });
  });

  it("passes metadata through", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "update_task_status");
    const meta = { findings: "done" };
    await (handler as Function)({ taskId: "task_1", status: "completed", metadata: meta });
    expect(client.updateTask).toHaveBeenCalledWith("task_1", {
      status: "completed",
      metadata: meta,
    });
  });

  it("returns MCP content format", async () => {
    const handler = getHandler(buildTools(mockClient(), AGENT_ID, PROJECT_ID), "update_task_status");
    const result = await (handler as Function)({ taskId: "task_1", status: "completed" });
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
  });
});

describe("send_message", () => {
  it("sends message with fromAgent set to this agent", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "send_message");
    await (handler as Function)({ threadId: "thread_1", type: "status", body: "Working on it" });
    expect(client.sendMessage).toHaveBeenCalledWith("thread_1", expect.objectContaining({
      fromAgent: AGENT_ID,
      type: "status",
      body: "Working on it",
    }));
  });

  it("passes toAgent when specified", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "send_message");
    await (handler as Function)({
      threadId: "thread_1",
      type: "handoff",
      body: "Done",
      toAgent: "agent_other",
    });
    expect(client.sendMessage).toHaveBeenCalledWith("thread_1", expect.objectContaining({
      toAgent: "agent_other",
    }));
  });

  it("returns MCP content format", async () => {
    const handler = getHandler(buildTools(mockClient(), AGENT_ID, PROJECT_ID), "send_message");
    const result = await (handler as Function)({ threadId: "thread_1", type: "status", body: "x" });
    expect(result.content[0].type).toBe("text");
  });
});

describe("get_unread_messages", () => {
  it("fetches unread for this agent", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "get_unread_messages");
    await (handler as Function)({});
    expect(client.getUnread).toHaveBeenCalledWith(AGENT_ID, PROJECT_ID);
  });

  it("returns 'No unread messages.' when empty", async () => {
    const handler = getHandler(buildTools(mockClient(), AGENT_ID, PROJECT_ID), "get_unread_messages");
    const result = await (handler as Function)({});
    expect(result.content[0].text).toBe("No unread messages.");
  });

  it("returns JSON when messages exist", async () => {
    const msg = { id: "msg_1", type: "handoff", body: "here it is" };
    const client = mockClient({ getUnread: vi.fn().mockResolvedValue([msg]) });
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "get_unread_messages");
    const result = await (handler as Function)({});
    expect(result.content[0].text).toContain("msg_1");
  });
});

describe("list_threads", () => {
  it("fetches threads for this project", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "list_threads");
    await (handler as Function)({});
    expect(client.listThreads).toHaveBeenCalledWith(PROJECT_ID, undefined);
  });

  it("returns 'No threads found.' when empty", async () => {
    const handler = getHandler(buildTools(mockClient(), AGENT_ID, PROJECT_ID), "list_threads");
    const result = await (handler as Function)({});
    expect(result.content[0].text).toBe("No threads found.");
  });
});

describe("create_thread", () => {
  it("creates thread in this project with given title", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "create_thread");
    await (handler as Function)({ title: "Auth design" });
    expect(client.createThread).toHaveBeenCalledWith({ projectId: PROJECT_ID, title: "Auth design" });
  });

  it("returns MCP content format with thread data", async () => {
    const handler = getHandler(buildTools(mockClient(), AGENT_ID, PROJECT_ID), "create_thread");
    const result = await (handler as Function)({ title: "test" });
    expect(result.content[0].text).toContain("thread_1");
  });
});

describe("list_all_tasks", () => {
  it("fetches tasks for this project without assignedTo filter", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "list_all_tasks");
    await (handler as Function)({});
    expect(client.getTasks).toHaveBeenCalledWith({ projectId: PROJECT_ID, status: undefined });
  });

  it("passes status filter through", async () => {
    const client = mockClient();
    const handler = getHandler(buildTools(client, AGENT_ID, PROJECT_ID), "list_all_tasks");
    await (handler as Function)({ status: "pending,assigned" });
    expect(client.getTasks).toHaveBeenCalledWith({ projectId: PROJECT_ID, status: "pending,assigned" });
  });
});

describe("create_task", () => {
  it("injects createdBy (this agent) and projectId, and passes core fields", async () => {
    const create = vi.fn().mockResolvedValue({ id: "task_new", title: "Do the thing" });
    const handler = getHandler(buildTools(mockClient({ createTask: create }), AGENT_ID, PROJECT_ID), "create_task");
    await (handler as Function)({ title: "Do the thing", description: "Details here" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      createdBy: AGENT_ID,
      title: "Do the thing",
      description: "Details here",
    }));
  });

  it("does NOT set status — the API derives it from assignedTo", async () => {
    const create = vi.fn().mockResolvedValue({ id: "task_new" });
    const handler = getHandler(buildTools(mockClient({ createTask: create }), AGENT_ID, PROJECT_ID), "create_task");
    await (handler as Function)({ title: "t", description: "d", assignedTo: "@auto" });
    const arg = create.mock.calls[0][0];
    expect(arg.status).toBeUndefined();
    expect(arg.assignedTo).toBe("@auto");
  });

  it("passes routing fields (assignedTo, domains, specialization, priority) through", async () => {
    const create = vi.fn().mockResolvedValue({ id: "task_new" });
    const handler = getHandler(buildTools(mockClient({ createTask: create }), AGENT_ID, PROJECT_ID), "create_task");
    await (handler as Function)({
      title: "t", description: "d",
      priority: "high", assignedTo: "agent_worker", domains: ["db"], specialization: "writer",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      priority: "high", assignedTo: "agent_worker", domains: ["db"], specialization: "writer",
    }));
  });

  it("passes a reviewer_agent verify predicate through", async () => {
    const create = vi.fn().mockResolvedValue({ id: "task_new" });
    const handler = getHandler(buildTools(mockClient({ createTask: create }), AGENT_ID, PROJECT_ID), "create_task");
    await (handler as Function)({
      title: "t", description: "d",
      verifyKind: "reviewer_agent", verifyReviewerId: "agent_reviewer",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      verifyKind: "reviewer_agent", verifyReviewerId: "agent_reviewer",
    }));
  });

  it("returns MCP content format with the created task", async () => {
    const handler = getHandler(buildTools(mockClient({ createTask: vi.fn().mockResolvedValue({ id: "task_new" }) }), AGENT_ID, PROJECT_ID), "create_task");
    const result = await (handler as Function)({ title: "t", description: "d" });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("task_new");
  });
});
