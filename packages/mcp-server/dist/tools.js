"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTools = buildTools;
const zod_1 = require("zod");
// Each tool: name, description (written for any AI model), input schema, handler.
// Descriptions are deliberately specific — vague descriptions produce wrong tool choices.
function buildTools(client, agentId, projectId) {
    return [
        {
            name: "get_my_tasks",
            description: "Retrieve tasks assigned to this agent. Use this at the start of a session or when you want " +
                "to know what work is queued for you. Returns tasks with status 'assigned' or 'in_progress'. " +
                "Always call this before starting new work so you don't duplicate effort.",
            inputSchema: zod_1.z.object({
                status: zod_1.z
                    .enum(["assigned", "in_progress", "pending", "all"])
                    .default("assigned")
                    .describe("Filter by task status. Use 'assigned' for new work, 'in_progress' for resuming."),
            }),
            handler: async (input) => {
                const status = input.status ?? "assigned";
                const statusFilter = status === "all" ? undefined : status;
                const tasks = await client.getTasks({ projectId, assignedTo: agentId, status: statusFilter });
                return {
                    content: [{
                            type: "text",
                            text: tasks.length === 0
                                ? "No tasks currently match that filter."
                                : JSON.stringify(tasks, null, 2),
                        }],
                };
            },
        },
        {
            name: "update_task_status",
            description: "Update the status of a task you are working on. Call this when you start work on a task " +
                "(set to 'in_progress'), finish it (set to 'completed'), or hit a blocker (set to 'blocked'). " +
                "Always update status when it changes — the orchestrator uses this to track progress and " +
                "route follow-on work.",
            inputSchema: zod_1.z.object({
                taskId: zod_1.z.string().describe("The ID of the task to update."),
                status: zod_1.z
                    .enum(["in_progress", "completed", "blocked", "cancelled"])
                    .describe("The new status."),
                metadata: zod_1.z
                    .record(zod_1.z.unknown())
                    .optional()
                    .describe("Optional structured data to attach — findings, outputs, links to commits, etc."),
            }),
            handler: async (input) => {
                const task = await client.updateTask(input.taskId, {
                    status: input.status,
                    metadata: input.metadata,
                });
                return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
            },
        },
        {
            name: "send_message",
            description: "Send a message to the orchestrator or another agent. Use the correct type: " +
                "'handoff' when you finish a task and the next agent needs context; " +
                "'finding' when you discover something that affects other work (not your current task); " +
                "'decision' to record an agreed-upon decision that all agents should honor; " +
                "'question' when you are blocked and need input before proceeding; " +
                "'escalation' when a decision needs human judgment; " +
                "'status' for routine progress updates. " +
                "Be specific in the body — the receiver has no other context.",
            inputSchema: zod_1.z.object({
                threadId: zod_1.z.string().describe("The thread to post to. Use list_threads to find or create one."),
                type: zod_1.z
                    .enum(["status", "handoff", "finding", "decision", "question", "escalation", "reply"])
                    .describe("Message type — see tool description for when to use each."),
                body: zod_1.z.string().min(1).describe("The message content. Be specific and self-contained."),
                toAgent: zod_1.z
                    .string()
                    .optional()
                    .describe("Agent ID to address directly. Omit to send to the orchestrator."),
                metadata: zod_1.z
                    .record(zod_1.z.unknown())
                    .optional()
                    .describe("Structured data: affected files, task IDs, decisions, etc."),
            }),
            handler: async (input) => {
                const message = await client.sendMessage(input.threadId, {
                    fromAgent: agentId,
                    toAgent: input.toAgent,
                    type: input.type,
                    body: input.body,
                    metadata: input.metadata,
                });
                return { content: [{ type: "text", text: JSON.stringify(message, null, 2) }] };
            },
        },
        {
            name: "get_unread_messages",
            description: "Retrieve messages sent to this agent that have not been read yet. Call this at session " +
                "start and after completing a task to check for new handoffs, findings, or decisions from " +
                "other agents. Always read messages before starting work on a related task.",
            inputSchema: zod_1.z.object({}),
            handler: async () => {
                const messages = await client.getUnread(agentId, projectId);
                return {
                    content: [{
                            type: "text",
                            text: messages.length === 0
                                ? "No unread messages."
                                : JSON.stringify(messages, null, 2),
                        }],
                };
            },
        },
        {
            name: "mark_thread_read",
            description: "Mark all messages in a thread as read by this agent. Call this after you have processed " +
                "the messages in a thread so other agents and the orchestrator know you have the context.",
            inputSchema: zod_1.z.object({
                threadId: zod_1.z.string().describe("The thread to mark as read."),
            }),
            handler: async (input) => {
                await client.markRead(input.threadId, agentId);
                return { content: [{ type: "text", text: "Thread marked as read." }] };
            },
        },
        {
            name: "list_threads",
            description: "List communication threads for this project. Pass type='plan' to list planning discussions " +
                "only, or omit type for operational threads. Use this to find the right thread before " +
                "sending a message, or to see open plans you can contribute to.",
            inputSchema: zod_1.z.object({
                type: zod_1.z
                    .enum(["plan"])
                    .optional()
                    .describe("Filter to a specific thread type. Use 'plan' to find collaborative planning discussions."),
            }),
            handler: async (input) => {
                const threads = await client.listThreads(projectId, input.type);
                return {
                    content: [{
                            type: "text",
                            text: threads.length === 0
                                ? "No threads found."
                                : JSON.stringify(threads, null, 2),
                        }],
                };
            },
        },
        {
            name: "create_thread",
            description: "Create a new thread. For operational coordination use the default (no type). To start a " +
                "collaborative planning discussion where multiple agents can share ideas and think through " +
                "a problem together, set type='plan'. All agents can read and contribute to open plans.",
            inputSchema: zod_1.z.object({
                title: zod_1.z.string().min(1).describe("A short descriptive title. For plans, phrase as a question or problem statement."),
                type: zod_1.z
                    .enum(["plan"])
                    .optional()
                    .describe("Set to 'plan' to create a collaborative planning discussion."),
            }),
            handler: async (input) => {
                const thread = await client.createThread({ projectId, title: input.title, type: input.type });
                return { content: [{ type: "text", text: JSON.stringify(thread, null, 2) }] };
            },
        },
        {
            name: "conclude_plan",
            description: "Mark a planning discussion as concluded and optionally write a summary of the decision or " +
                "outcome. Use this when the group has reached a conclusion and the plan is complete. " +
                "Concluded plans are read-only — no further messages can be added.",
            inputSchema: zod_1.z.object({
                threadId: zod_1.z.string().describe("The plan thread ID to conclude."),
                summary: zod_1.z.string().optional().describe("A summary of the decision or outcome reached. Recommended."),
            }),
            handler: async (input) => {
                const thread = await client.concludePlan(input.threadId, input.summary);
                return { content: [{ type: "text", text: JSON.stringify(thread, null, 2) }] };
            },
        },
        {
            name: "list_all_tasks",
            description: "List tasks across the project, optionally filtered by status. Use this to get a full " +
                "picture of project state — what's pending, in progress, blocked, or completed. " +
                "Prefer get_my_tasks when you only need your own work queue.",
            inputSchema: zod_1.z.object({
                status: zod_1.z
                    .string()
                    .optional()
                    .describe("Comma-separated statuses to filter by, e.g. 'pending,assigned'. Omit for all."),
            }),
            handler: async (input) => {
                const tasks = await client.getTasks({ projectId, status: input.status });
                return {
                    content: [{
                            type: "text",
                            text: tasks.length === 0
                                ? "No tasks found."
                                : JSON.stringify(tasks, null, 2),
                        }],
                };
            },
        },
    ];
}
//# sourceMappingURL=tools.js.map