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
    ...overrides,
  } as unknown as ApiClient;
}

function getHandler(tools: ReturnType<typeof buildTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool.handler;
}

describe("buildTools", () => {
  it("returns all 8 tools", () => {
    const tools = buildTools(mockClient(), AGENT_ID, PROJECT_ID);
    expect(tools).toHaveLength(8);
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_my_tasks");
    expect(names).toContain("update_task_status");
    expect(names).toContain("send_message");
    expect(names).toContain("get_unread_messages");
    expect(names).toContain("mark_thread_read");
    expect(names).toContain("list_threads");
    expect(names).toContain("create_thread");
    expect(names).toContain("list_all_tasks");
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
    expect(client.listThreads).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("returns 'No threads exist yet.' when empty", async () => {
    const handler = getHandler(buildTools(mockClient(), AGENT_ID, PROJECT_ID), "list_threads");
    const result = await (handler as Function)({});
    expect(result.content[0].text).toBe("No threads exist yet.");
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
