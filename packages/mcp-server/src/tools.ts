import { z } from "zod";
import type { ApiClient } from "./api-client.js";

// Each tool: name, description (written for any AI model), input schema, handler.
// Descriptions are deliberately specific — vague descriptions produce wrong tool choices.

export function buildTools(client: ApiClient, agentId: string, repoId: string) {
  return [
    {
      name: "create_task",
      description:
        "Create a new task in this project — use this to turn a plan into actionable work (e.g. an " +
        "architect/planner breaking a design into tasks for workers). You are recorded as the task's " +
        "creator automatically. Assign with assignedTo: an agent ID assigns directly, '@auto' lets the " +
        "routing scheduler pick (task stays 'pending'), or omit to use the project default. Do NOT set " +
        "status — it's derived (assigned when there's a concrete assignee, else pending). Optionally add " +
        "a completion gate via verifyKind: 'reviewer_agent' (set verifyReviewerId — that agent must " +
        "approve via submit_review), 'file_exists' (verifyPath), or 'thread_concluded' (verifyThreadId). " +
        "The 'shell' kind (verifyCommand) is restricted to orchestrator agents and 403s otherwise. " +
        "Note: if you are a worker (not an orchestrator), this creates a *proposal* — the task lands in " +
        "'proposed' with your assignedTo kept only as a hint, and an orchestrator must commit it before " +
        "it becomes real work. Orchestrators commit on creation.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Short, action-oriented task title."),
        description: z.string().min(1).describe("What to do, with enough context to start. Reference specs/files."),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Defaults to 'normal'."),
        assignedTo: z.string().optional().describe("Agent ID to assign directly, '@auto' for the router, or omit for the project default."),
        domains: z.array(z.string()).optional().describe("Domain tags for rules-based routing, e.g. ['database','schema']."),
        specialization: z.string().optional().describe("Specialization the task needs, for routing (e.g. 'writer')."),
        verifyKind: z.enum(["shell", "file_exists", "thread_concluded", "reviewer_agent"]).optional().describe("Optional completion gate — see tool description."),
        verifyReviewerId: z.string().optional().describe("For verifyKind='reviewer_agent': agent ID that must approve."),
        verifyThreadId: z.string().optional().describe("For verifyKind='thread_concluded': thread whose conclusion gates completion."),
        verifyPath: z.string().optional().describe("For verifyKind='file_exists': path that must exist."),
        verifyCommand: z.string().optional().describe("For verifyKind='shell' (orchestrator only): command that must exit 0."),
        verifyCwd: z.string().optional().describe("Working directory for shell/file_exists predicates."),
        verifyTimeoutMs: z.number().int().optional().describe("Timeout for shell predicate (1000–600000 ms)."),
      }),
      handler: async (input: {
        title: string; description: string; priority?: string; assignedTo?: string;
        domains?: string[]; specialization?: string;
        verifyKind?: string; verifyReviewerId?: string; verifyThreadId?: string;
        verifyPath?: string; verifyCommand?: string; verifyCwd?: string; verifyTimeoutMs?: number;
      }) => {
        // createdBy + repoId are injected from this agent's identity. Status is
        // intentionally NOT set — the API derives it from the effective assignee.
        const task = await client.createTask({
          repoId,
          createdBy: agentId,
          title: input.title,
          description: input.description,
          priority: input.priority,
          assignedTo: input.assignedTo,
          domains: input.domains,
          specialization: input.specialization,
          verifyKind: input.verifyKind,
          verifyReviewerId: input.verifyReviewerId,
          verifyThreadId: input.verifyThreadId,
          verifyPath: input.verifyPath,
          verifyCommand: input.verifyCommand,
          verifyCwd: input.verifyCwd,
          verifyTimeoutMs: input.verifyTimeoutMs,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
      },
    },

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
        const tasks = await client.getTasks({ repoId, assignedTo: agentId, status: statusFilter });
        return {
          content: [{
            type: "text" as const,
            text: tasks.length === 0
              ? "No tasks currently match that filter."
              // Wrap in an object: a bare JSON array as content trips strict MCP
              // clients (e.g. Gemini CLI) that validate derived structuredContent
              // as a record. See docs/relai-improvements.md.
              : JSON.stringify({ tasks }, null, 2),
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
        "Be specific in the body — the receiver has no other context. " +
        "IMPORTANT: if you were asked something via a relai message or task (toAgent=you, or a task " +
        "assigned to you), your answer belongs here, posted on that same threadId — not just written " +
        "in your own session output. The requester only sees what you post through send_message.",
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
        "other agents. Always read messages before starting work on a related task. " +
        "Any message that expects a reply (a question, a request, an instruction from a human " +
        "operator) must be answered with send_message on its threadId — answering in your own " +
        "session output is invisible to the sender.",
      inputSchema: z.object({}),
      handler: async () => {
        const messages = await client.getUnread(agentId, repoId);
        return {
          content: [{
            type: "text" as const,
            text: messages.length === 0
              ? "No unread messages."
              : JSON.stringify({
                  messages,
                  reminder: "If any of the above needs a reply, call send_message with the same " +
                    "threadId — your sender will not see anything you only write in your own session.",
                }, null, 2),
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
        const threads = await client.listThreads(repoId, input.type);
        return {
          content: [{
            type: "text" as const,
            text: threads.length === 0
              ? "No threads found."
              : JSON.stringify({ threads }, null, 2),
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
        const thread = await client.createThread({ repoId, title: input.title, type: input.type });
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
      name: "archive_task",
      description:
        "Archive a finished task so it drops out of the default task lists and your session_start " +
        "snapshot, keeping your live view small. The task must already be completed or cancelled. " +
        "Archiving does not delete anything — the task stays queryable and is purely hidden from " +
        "the default views.",
      inputSchema: z.object({
        taskId: z.string().describe("The completed or cancelled task ID to archive."),
      }),
      handler: async (input: { taskId: string }) => {
        const task = await client.archiveTask(input.taskId);
        return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
      },
    },

    {
      name: "archive_thread",
      description:
        "Archive a concluded thread (planning OR operational) so it drops out of the default thread " +
        "lists and your session_start snapshot. The thread must already be concluded. Archiving does " +
        "not delete anything — messages stay queryable and the thread is purely hidden from default views.",
      inputSchema: z.object({
        threadId: z.string().describe("The concluded thread ID to archive."),
      }),
      handler: async (input: { threadId: string }) => {
        const thread = await client.archiveThread(input.threadId);
        return { content: [{ type: "text" as const, text: JSON.stringify(thread, null, 2) }] };
      },
    },

    {
      name: "session_start",
      description:
        "Get a single bundled snapshot of your current state in this repo: your identity, the " +
        "project's pinned context (the 'everyone-reads-this' notes), your open tasks (with a " +
        "human-readable label like 'Running' / 'Stalled' / 'Input required'), unread messages " +
        "addressed to your project, and open threads you're subscribed to. Call this FIRST at the " +
        "start of every session — it replaces the get_my_tasks + get_unread_messages + list_threads " +
        "calls you would otherwise need to orient yourself, and includes context those tools don't " +
        "expose. Read the project context carefully before doing any work. Any unreadMessages that " +
        "expect a reply must be answered via send_message on the same threadId, not just in your " +
        "own session output.",
      inputSchema: z.object({}),
      handler: async () => {
        const session = await client.getSessionStart(repoId);
        const unread = (session.unreadMessages as unknown[] | undefined) ?? [];
        const payload = unread.length > 0
          ? {
              ...session,
              reminder: "unreadMessages above may need a reply — call send_message with the same " +
                "threadId. The sender will not see anything you only write in your own session.",
            }
          : session;
        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
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
        const tasks = await client.getTasks({ repoId, status: input.status });
        return {
          content: [{
            type: "text" as const,
            text: tasks.length === 0
              ? "No tasks found."
              : JSON.stringify({ tasks }, null, 2),
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

    {
      name: "commit_task",
      description:
        "Orchestrator-only: act on a worker's proposed task (a task in status 'proposed'). 'commit' " +
        "(the default) gives it an owner and moves it into the lifecycle — set assignedTo to an agent ID, " +
        "'@auto' to let the router pick, or omit for the project default. 'reject' cancels the proposal " +
        "and notifies the proposer (include a note). You may ratify edits in the same call (title, " +
        "description, priority, domains, specialization, and verify fields); verify changes are " +
        "re-validated. Non-orchestrators get 403; non-proposed tasks get 409.",
      inputSchema: z.object({
        taskId:         z.string().describe("The ID of the proposed task to commit or reject."),
        decision:       z.enum(["commit", "reject"]).optional().describe("Defaults to 'commit'."),
        assignedTo:     z.string().optional().describe("Agent ID, '@auto', or omit for the project default (commit only)."),
        note:           z.string().max(2_000).optional().describe("Explanation, especially for reject."),
        title:          z.string().min(1).optional().describe("Ratified title edit."),
        description:    z.string().min(1).optional().describe("Ratified description edit."),
        priority:       z.enum(["low", "normal", "high", "urgent"]).optional().describe("Ratified priority."),
        domains:        z.array(z.string()).optional().describe("Ratified domain tags."),
        specialization: z.string().optional().describe("Ratified specialization."),
        verifyKind:       z.enum(["shell", "file_exists", "thread_concluded", "reviewer_agent"]).optional(),
        verifyReviewerId: z.string().optional(),
        verifyThreadId:   z.string().optional(),
        verifyPath:       z.string().optional(),
        verifyCommand:    z.string().optional(),
        verifyCwd:        z.string().optional(),
        verifyTimeoutMs:  z.number().int().optional(),
      }),
      handler: async (input: {
        taskId: string; decision?: "commit" | "reject"; assignedTo?: string; note?: string;
        title?: string; description?: string; priority?: string; domains?: string[]; specialization?: string;
        verifyKind?: string; verifyReviewerId?: string; verifyThreadId?: string;
        verifyPath?: string; verifyCommand?: string; verifyCwd?: string; verifyTimeoutMs?: number;
      }) => {
        // Build the body with only the fields that were supplied, so the request
        // mirrors the caller's intent (no stray undefined keys).
        const { taskId, decision, ...rest } = input;
        const body: Record<string, unknown> = { decision: decision ?? "commit" };
        for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
        const task = await client.commitTask(taskId, body);
        return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
      },
    },
  ];
}

// Operator (owner) toolset — used when the MCP server runs in owner mode (an
// owner credential instead of a per-agent token). These act across ALL of the
// owner's projects: the API scopes by the X-Owner-Id the client sends, and each
// resource is addressed by its own id, so no repoId argument is needed. The
// human (you, e.g. from a phone) drives these to triage and unblock work
// remotely. Keep this set small — it's a different surface from the 13 agent
// tools, not an extension of them.
export function buildOperatorTools(client: ApiClient) {
  return [
    {
      name: "list_attention",
      description:
        "List everything across ALL your projects that needs you right now: tasks that are 'blocked' " +
        "(a worker is waiting on your input), 'pending_verification' (awaiting a review decision), or " +
        "'proposed' (a worker's task awaiting your commit). Call this first to see what to act on. Each " +
        "task carries its repoId and, for blocked tasks, metadata.blockedThreadId — the thread to " +
        "post a reply on (via reply_human) to resume the worker.",
      inputSchema: z.object({}),
      handler: async () => {
        const tasks = await client.getTasks({ status: "blocked,pending_verification,proposed" });
        return {
          content: [{
            type: "text" as const,
            text: tasks.length === 0
              ? "Nothing needs your attention across your projects right now."
              : JSON.stringify({ tasks }, null, 2),
          }],
        };
      },
    },

    {
      name: "get_task",
      description:
        "Fetch one task's full detail by id — title, description, status, assignee, and metadata " +
        "(including blockedThreadId and the worker's question/findings). Use this to understand a " +
        "blocked or proposed task before you reply, review, or commit.",
      inputSchema: z.object({
        taskId: z.string().describe("The task id to fetch."),
      }),
      handler: async (input: { taskId: string }) => {
        const task = await client.getTask(input.taskId);
        return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
      },
    },

    {
      name: "reply_human",
      description:
        "Post a reply to a thread AS THE HUMAN owner. This is how you unblock a stalled task: reply on " +
        "its blockedThreadId (from list_attention) and the server resumes the worker with your answer. " +
        "The message is recorded as from 'human' regardless of what you pass. Be specific — the worker " +
        "acts on exactly what you write.",
      inputSchema: z.object({
        threadId: z.string().describe("The thread to reply on. For an unblock, use the task's metadata.blockedThreadId."),
        body:     z.string().min(1).describe("Your answer/instruction to the worker."),
        type:     z.enum(["status", "handoff", "finding", "decision", "question", "escalation", "reply"]).optional().describe("Defaults to 'reply'."),
      }),
      handler: async (input: { threadId: string; body: string; type?: string }) => {
        const message = await client.sendMessage(input.threadId, {
          fromAgent: "human",
          type: input.type ?? "reply",
          body: input.body,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(message, null, 2) }] };
      },
    },

    {
      name: "review_task",
      description:
        "Submit a review decision on a task whose completion is gated on a reviewer (verifyKind=" +
        "'reviewer_agent') and is in 'pending_verification'. 'approve' promotes it to 'completed'; " +
        "'reject' sends it back to 'assigned' for the worker to iterate. Include a note on reject.",
      inputSchema: z.object({
        taskId:   z.string().describe("The task id to review."),
        decision: z.enum(["approve", "reject"]).describe("Approve or reject."),
        note:     z.string().max(2_000).optional().describe("Required for reject; useful for approve."),
      }),
      handler: async (input: { taskId: string; decision: "approve" | "reject"; note?: string }) => {
        const task = await client.submitReview(input.taskId, { decision: input.decision, note: input.note });
        return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
      },
    },

    {
      name: "commit_proposal",
      description:
        "Act on a worker's proposed task (status 'proposed'). 'commit' (default) moves it into the " +
        "lifecycle — set assignedTo to an agent id, '@auto' for the router, or omit for the project " +
        "default. 'reject' cancels it and notifies the proposer (include a note).",
      inputSchema: z.object({
        taskId:     z.string().describe("The proposed task id."),
        decision:   z.enum(["commit", "reject"]).optional().describe("Defaults to 'commit'."),
        assignedTo: z.string().optional().describe("Agent id, '@auto', or omit for the project default (commit only)."),
        note:       z.string().max(2_000).optional().describe("Explanation, especially for reject."),
      }),
      handler: async (input: { taskId: string; decision?: "commit" | "reject"; assignedTo?: string; note?: string }) => {
        const body: Record<string, unknown> = { decision: input.decision ?? "commit" };
        if (input.assignedTo !== undefined) body.assignedTo = input.assignedTo;
        if (input.note !== undefined) body.note = input.note;
        const task = await client.commitTask(input.taskId, body);
        return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
      },
    },
  ];
}
