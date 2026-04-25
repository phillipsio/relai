"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const tools_js_1 = require("./tools.js");
const AGENT_ID = "agent_test";
const PROJECT_ID = "proj_test";
function mockClient(overrides = {}) {
    return {
        getTasks: vitest_1.vi.fn().mockResolvedValue([]),
        getTask: vitest_1.vi.fn().mockResolvedValue({}),
        createTask: vitest_1.vi.fn().mockResolvedValue({}),
        updateTask: vitest_1.vi.fn().mockResolvedValue({ id: "task_1", status: "in_progress" }),
        sendMessage: vitest_1.vi.fn().mockResolvedValue({ id: "msg_1", type: "status" }),
        getMessages: vitest_1.vi.fn().mockResolvedValue([]),
        getUnread: vitest_1.vi.fn().mockResolvedValue([]),
        markRead: vitest_1.vi.fn().mockResolvedValue({}),
        registerAgent: vitest_1.vi.fn().mockResolvedValue({}),
        heartbeat: vitest_1.vi.fn().mockResolvedValue({}),
        listAgents: vitest_1.vi.fn().mockResolvedValue([]),
        createThread: vitest_1.vi.fn().mockResolvedValue({ id: "thread_1", title: "test" }),
        listThreads: vitest_1.vi.fn().mockResolvedValue([]),
        ...overrides,
    };
}
function getHandler(tools, name) {
    const tool = tools.find((t) => t.name === name);
    if (!tool)
        throw new Error(`Tool ${name} not found`);
    return tool.handler;
}
(0, vitest_1.describe)("buildTools", () => {
    (0, vitest_1.it)("returns all 8 tools", () => {
        const tools = (0, tools_js_1.buildTools)(mockClient(), AGENT_ID, PROJECT_ID);
        (0, vitest_1.expect)(tools).toHaveLength(8);
        const names = tools.map((t) => t.name);
        (0, vitest_1.expect)(names).toContain("get_my_tasks");
        (0, vitest_1.expect)(names).toContain("update_task_status");
        (0, vitest_1.expect)(names).toContain("send_message");
        (0, vitest_1.expect)(names).toContain("get_unread_messages");
        (0, vitest_1.expect)(names).toContain("mark_thread_read");
        (0, vitest_1.expect)(names).toContain("list_threads");
        (0, vitest_1.expect)(names).toContain("create_thread");
        (0, vitest_1.expect)(names).toContain("list_all_tasks");
    });
});
(0, vitest_1.describe)("get_my_tasks", () => {
    (0, vitest_1.it)("defaults to status=assigned when no input provided", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "get_my_tasks");
        await handler({});
        (0, vitest_1.expect)(client.getTasks).toHaveBeenCalledWith({
            projectId: PROJECT_ID,
            assignedTo: AGENT_ID,
            status: "assigned",
        });
    });
    (0, vitest_1.it)("passes explicit status through", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "get_my_tasks");
        await handler({ status: "in_progress" });
        (0, vitest_1.expect)(client.getTasks).toHaveBeenCalledWith({
            projectId: PROJECT_ID,
            assignedTo: AGENT_ID,
            status: "in_progress",
        });
    });
    (0, vitest_1.it)("passes undefined status when 'all' is requested", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "get_my_tasks");
        await handler({ status: "all" });
        (0, vitest_1.expect)(client.getTasks).toHaveBeenCalledWith({
            projectId: PROJECT_ID,
            assignedTo: AGENT_ID,
            status: undefined,
        });
    });
    (0, vitest_1.it)("returns MCP content format", async () => {
        const task = { id: "task_1", title: "Test task", status: "assigned" };
        const client = mockClient({ getTasks: vitest_1.vi.fn().mockResolvedValue([task]) });
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "get_my_tasks");
        const result = await handler({});
        (0, vitest_1.expect)(result).toHaveProperty("content");
        (0, vitest_1.expect)(result.content[0].type).toBe("text");
        (0, vitest_1.expect)(result.content[0].text).toContain("task_1");
    });
    (0, vitest_1.it)("returns empty message text when no tasks found", async () => {
        const handler = getHandler((0, tools_js_1.buildTools)(mockClient(), AGENT_ID, PROJECT_ID), "get_my_tasks");
        const result = await handler({});
        (0, vitest_1.expect)(result.content[0].text).toBe("No tasks currently match that filter.");
    });
});
(0, vitest_1.describe)("update_task_status", () => {
    (0, vitest_1.it)("calls updateTask with correct args", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "update_task_status");
        await handler({ taskId: "task_1", status: "in_progress" });
        (0, vitest_1.expect)(client.updateTask).toHaveBeenCalledWith("task_1", {
            status: "in_progress",
            metadata: undefined,
        });
    });
    (0, vitest_1.it)("passes metadata through", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "update_task_status");
        const meta = { findings: "done" };
        await handler({ taskId: "task_1", status: "completed", metadata: meta });
        (0, vitest_1.expect)(client.updateTask).toHaveBeenCalledWith("task_1", {
            status: "completed",
            metadata: meta,
        });
    });
    (0, vitest_1.it)("returns MCP content format", async () => {
        const handler = getHandler((0, tools_js_1.buildTools)(mockClient(), AGENT_ID, PROJECT_ID), "update_task_status");
        const result = await handler({ taskId: "task_1", status: "completed" });
        (0, vitest_1.expect)(result.content[0].type).toBe("text");
        (0, vitest_1.expect)(typeof result.content[0].text).toBe("string");
    });
});
(0, vitest_1.describe)("send_message", () => {
    (0, vitest_1.it)("sends message with fromAgent set to this agent", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "send_message");
        await handler({ threadId: "thread_1", type: "status", body: "Working on it" });
        (0, vitest_1.expect)(client.sendMessage).toHaveBeenCalledWith("thread_1", vitest_1.expect.objectContaining({
            fromAgent: AGENT_ID,
            type: "status",
            body: "Working on it",
        }));
    });
    (0, vitest_1.it)("passes toAgent when specified", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "send_message");
        await handler({
            threadId: "thread_1",
            type: "handoff",
            body: "Done",
            toAgent: "agent_other",
        });
        (0, vitest_1.expect)(client.sendMessage).toHaveBeenCalledWith("thread_1", vitest_1.expect.objectContaining({
            toAgent: "agent_other",
        }));
    });
    (0, vitest_1.it)("returns MCP content format", async () => {
        const handler = getHandler((0, tools_js_1.buildTools)(mockClient(), AGENT_ID, PROJECT_ID), "send_message");
        const result = await handler({ threadId: "thread_1", type: "status", body: "x" });
        (0, vitest_1.expect)(result.content[0].type).toBe("text");
    });
});
(0, vitest_1.describe)("get_unread_messages", () => {
    (0, vitest_1.it)("fetches unread for this agent", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "get_unread_messages");
        await handler({});
        (0, vitest_1.expect)(client.getUnread).toHaveBeenCalledWith(AGENT_ID, PROJECT_ID);
    });
    (0, vitest_1.it)("returns 'No unread messages.' when empty", async () => {
        const handler = getHandler((0, tools_js_1.buildTools)(mockClient(), AGENT_ID, PROJECT_ID), "get_unread_messages");
        const result = await handler({});
        (0, vitest_1.expect)(result.content[0].text).toBe("No unread messages.");
    });
    (0, vitest_1.it)("returns JSON when messages exist", async () => {
        const msg = { id: "msg_1", type: "handoff", body: "here it is" };
        const client = mockClient({ getUnread: vitest_1.vi.fn().mockResolvedValue([msg]) });
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "get_unread_messages");
        const result = await handler({});
        (0, vitest_1.expect)(result.content[0].text).toContain("msg_1");
    });
});
(0, vitest_1.describe)("list_threads", () => {
    (0, vitest_1.it)("fetches threads for this project", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "list_threads");
        await handler({});
        (0, vitest_1.expect)(client.listThreads).toHaveBeenCalledWith(PROJECT_ID);
    });
    (0, vitest_1.it)("returns 'No threads exist yet.' when empty", async () => {
        const handler = getHandler((0, tools_js_1.buildTools)(mockClient(), AGENT_ID, PROJECT_ID), "list_threads");
        const result = await handler({});
        (0, vitest_1.expect)(result.content[0].text).toBe("No threads exist yet.");
    });
});
(0, vitest_1.describe)("create_thread", () => {
    (0, vitest_1.it)("creates thread in this project with given title", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "create_thread");
        await handler({ title: "Auth design" });
        (0, vitest_1.expect)(client.createThread).toHaveBeenCalledWith({ projectId: PROJECT_ID, title: "Auth design" });
    });
    (0, vitest_1.it)("returns MCP content format with thread data", async () => {
        const handler = getHandler((0, tools_js_1.buildTools)(mockClient(), AGENT_ID, PROJECT_ID), "create_thread");
        const result = await handler({ title: "test" });
        (0, vitest_1.expect)(result.content[0].text).toContain("thread_1");
    });
});
(0, vitest_1.describe)("list_all_tasks", () => {
    (0, vitest_1.it)("fetches tasks for this project without assignedTo filter", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "list_all_tasks");
        await handler({});
        (0, vitest_1.expect)(client.getTasks).toHaveBeenCalledWith({ projectId: PROJECT_ID, status: undefined });
    });
    (0, vitest_1.it)("passes status filter through", async () => {
        const client = mockClient();
        const handler = getHandler((0, tools_js_1.buildTools)(client, AGENT_ID, PROJECT_ID), "list_all_tasks");
        await handler({ status: "pending,assigned" });
        (0, vitest_1.expect)(client.getTasks).toHaveBeenCalledWith({ projectId: PROJECT_ID, status: "pending,assigned" });
    });
});
//# sourceMappingURL=tools.test.js.map