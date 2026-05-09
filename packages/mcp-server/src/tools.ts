import { z } from "zod";
import type { ApiClient } from "./api-client.js";

// Each tool: name, description (written for any AI model), input schema, handler.
// Descriptions are deliberately specific — vague descriptions produce wrong tool choices.

export function buildTools(client: ApiClient, agentId: string, projectId: string) {
  return [
    {
      name: "get_my_tasks",
      description:
        "Retrieve tasks assigned to this agent. Use this at the start of a session or when you want " +
        "to know what work is queued for you. Returns tasks with status 'assigned' or 'in_progress'. " +
        "Always call this before starting new work so you don't duplicate effort.",
      inputSchema: z.object({
        status: z
          .enum(["assigned", "in_progress", "pending", "all"])
          .default("assigned")
          .describe("Filter by task status. Use 'assigned' for new work, 'in_progress' for resuming."),
      }),
      handler: async (input: { status?: string }) => {
        const status = input.status ?? "assigned";
        const statusFilter = status === "all" ? undefined : status;
        const tasks = await client.getTasks({ projectId, assignedTo: agentId, status: statusFilter });
        return {
          content: [{
            type: "text" as const,
            text: tasks.length === 0
              ? "No tasks currently match that filter."
              : JSON.stringify(tasks, null, 2),
          }],
        };
      },
    },

    {
      name: "update_task_status",
      description:
        "Update the status of a task you are working on. Call this when you start work on a task " +
        "(set to 'in_progress'), finish it (set to 'completed'), or hit a blocker (set to 'blocked'). " +
        "Always update status when it changes — the orchestrator uses this to track progress and " +
        "route follow-on work. Note: tasks with a verifyCommand have completion gated — the server " +
        "may return status 'pending_verification' while a predicate runs; if it fails the task is " +
        "returned to 'assigned' with details on metadata.lastVerification.",
      inputSchema: z.object({
        taskId: z.string().describe("The ID of the task to update."),
        status: z
          .enum(["in_progress", "completed", "blocked", "cancelled"])
          .describe("The new status."),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe("Optional structured data to attach — findings, outputs, links to commits, etc."),
      }),
      handler: async (input: { taskId: string; status: string; metadata?: Record<string, unknown> }) => {
        const task = await client.updateTask(input.taskId, {
          status: input.status,
          metadata: input.metadata,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
      },
    },

    {
      name: "send_message",
      description:
        "Send a message to the orchestrator or another agent. Use the correct type: " +
        "'handoff' when you finish a task and the next agent needs context; " +
        "'finding' when you discover something that affects other work (not your current task); " +
        "'decision' to record an agreed-upon decision that all agents should honor; " +
        "'question' when you are blocked and need input before proceeding; " +
        "'escalation' when a decision needs human judgment; " +
        "'status' for routine progress updates. " +
        "Be specific in the body — the receiver has no other context.",
      inputSchema: z.object({
        threadId: z.string().describe("The thread to post to. Use list_threads to find or create one."),
        type: z
          .enum(["status", "handoff", "finding", "decision", "question", "escalation", "reply"])
          .describe("Message type — see tool description for when to use each."),
        body: z.string().min(1).describe("The message content. Be specific and self-contained."),
        toAgent: z
          .string()
          .optional()
          .describe("Agent ID to address directly. Omit to send to the orchestrator."),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe("Structured data: affected files, task IDs, decisions, etc."),
      }),
      handler: async (input: {
        threadId: string;
        type: string;
        body: string;
        toAgent?: string;
        metadata?: Record<string, unknown>;
      }) => {
        const message = await client.sendMessage(input.threadId, {
          fromAgent: agentId,
          toAgent: input.toAgent,
          type: input.type,
          body: input.body,
          metadata: input.metadata,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(message, null, 2) }] };
      },
    },

    {
      name: "get_unread_messages",
      description:
        "Retrieve messages sent to this agent that have not been read yet. Call this at session " +
        "start and after completing a task to check for new handoffs, findings, or decisions from " +
        "other agents. Always read messages before starting work on a related task.",
      inputSchema: z.object({}),
      handler: async () => {
        const messages = await client.getUnread(agentId, projectId);
        return {
          content: [{
            type: "text" as const,
            text: messages.length === 0
              ? "No unread messages."
              : JSON.stringify(messages, null, 2),
          }],
        };
      },
    },

    {
      name: "mark_thread_read",
      description:
        "Mark all messages in a thread as read by this agent. Call this after you have processed " +
        "the messages in a thread so other agents and the orchestrator know you have the context.",
      inputSchema: z.object({
        threadId: z.string().describe("The thread to mark as read."),
      }),
      handler: async (input: { threadId: string }) => {
        await client.markRead(input.threadId, agentId);
        return { content: [{ type: "text" as const, text: "Thread marked as read." }] };
      },
    },

    {
      name: "list_threads",
      description:
        "List communication threads for this project. Pass type='plan' to list planning discussions " +
        "only, or omit type for operational threads. Use this to find the right thread before " +
        "sending a message, or to see open plans you can contribute to.",
      inputSchema: z.object({
        type: z
          .enum(["plan"])
          .optional()
          .describe("Filter to a specific thread type. Use 'plan' to find collaborative planning discussions."),
      }),
      handler: async (input: { type?: string }) => {
        const threads = await client.listThreads(projectId, input.type);
        return {
          content: [{
            type: "text" as const,
            text: threads.length === 0
              ? "No threads found."
              : JSON.stringify(threads, null, 2),
          }],
        };
      },
    },

    {
      name: "create_thread",
      description:
        "Create a new thread. For operational coordination use the default (no type). To start a " +
        "collaborative planning discussion where multiple agents can share ideas and think through " +
        "a problem together, set type='plan'. All agents can read and contribute to open plans.",
      inputSchema: z.object({
        title: z.string().min(1).describe("A short descriptive title. For plans, phrase as a question or problem statement."),
        type: z
          .enum(["plan"])
          .optional()
          .describe("Set to 'plan' to create a collaborative planning discussion."),
      }),
      handler: async (input: { title: string; type?: string }) => {
        const thread = await client.createThread({ projectId, title: input.title, type: input.type });
        return { content: [{ type: "text" as const, text: JSON.stringify(thread, null, 2) }] };
      },
    },

    {
      name: "conclude_plan",
      description:
        "Mark a planning discussion as concluded and optionally write a summary of the decision or " +
        "outcome. Use this when the group has reached a conclusion and the plan is complete. " +
        "Concluded plans are read-only — no further messages can be added.",
      inputSchema: z.object({
        threadId: z.string().describe("The plan thread ID to conclude."),
        summary: z.string().optional().describe("A summary of the decision or outcome reached. Recommended."),
      }),
      handler: async (input: { threadId: string; summary?: string }) => {
        const thread = await client.concludePlan(input.threadId, input.summary);
        return { content: [{ type: "text" as const, text: JSON.stringify(thread, null, 2) }] };
      },
    },

    {
      name: "session_start",
      description:
        "Get a single bundled snapshot of your current state in this project: your identity, the " +
        "project's pinned context (the 'everyone-reads-this' notes), your open tasks (with a " +
        "human-readable label like 'Running' / 'Stalled' / 'Input required'), unread messages " +
        "addressed to your project, and open threads you're subscribed to. Call this FIRST at the " +
        "start of every session — it replaces the get_my_tasks + get_unread_messages + list_threads " +
        "calls you would otherwise need to orient yourself, and includes context those tools don't " +
        "expose. Read the project context carefully before doing any work.",
      inputSchema: z.object({}),
      handler: async () => {
        const session = await client.getSessionStart(projectId);
        return { content: [{ type: "text" as const, text: JSON.stringify(session, null, 2) }] };
      },
    },

    {
      name: "list_all_tasks",
      description:
        "List tasks across the project, optionally filtered by status. Use this to get a full " +
        "picture of project state — what's pending, in progress, blocked, or completed. " +
        "Prefer get_my_tasks when you only need your own work queue.",
      inputSchema: z.object({
        status: z
          .string()
          .optional()
          .describe("Comma-separated statuses to filter by, e.g. 'pending,assigned'. Omit for all."),
      }),
      handler: async (input: { status?: string }) => {
        const tasks = await client.getTasks({ projectId, status: input.status });
        return {
          content: [{
            type: "text" as const,
            text: tasks.length === 0
              ? "No tasks found."
              : JSON.stringify(tasks, null, 2),
          }],
        };
      },
    },

    {
      name: "submit_review",
      description:
        "Submit your approval decision on a task that names you as the reviewer (verifyKind=" +
        "'reviewer_agent'). The task must be in 'pending_verification'. Approve to promote it to " +
        "'completed'; reject to send it back to 'assigned' so the original worker can iterate. " +
        "Reject decisions should include a note explaining what to change.",
      inputSchema: z.object({
        taskId:   z.string().describe("The ID of the task you are reviewing."),
        decision: z.enum(["approve", "reject"]).describe("Approve or reject."),
        note:     z.string().max(2_000).optional().describe("Required for reject; useful for approve. Concise reason or guidance."),
      }),
      handler: async (input: { taskId: string; decision: "approve" | "reject"; note?: string }) => {
        const task = await client.submitReview(input.taskId, { decision: input.decision, note: input.note });
        return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
      },
    },
  ];
}
