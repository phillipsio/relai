// In-process message loop. Watches the project's orchestrator agent for unread
// inbound messages and dispatches by message type:
//
//   status, reply              → no action; mark read.
//   escalation                 → create a task for the most-senior available
//                                agent (tier=2 or specialization=architect),
//                                assign it directly, post a reply on the
//                                originating thread.
//   decision                   → broadcast to every online worker.
//   handoff, question, finding → ask Claude (route_message tool) to choose
//                                between create_task / forward / broadcast /
//                                reply / log_only and execute the choice.
//
// The loop is gated by ENABLE_MESSAGE_ROUTING — opt-in because the
// classifier issues a Claude call per inbound handoff/question/finding,
// which costs money. When disabled, messages.ts continues to run its
// fallback escalation auto-task path (a stripped-down legacy of this
// loop). When enabled, the route's auto-create is skipped to avoid
// duplicate tasks; this loop owns the full lifecycle.

import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import {
  agents as agentsTable,
  messages as messagesTable,
  tasks as tasksTable,
  threads as threadsTable,
} from "@getrelai/db";
import type { Db } from "@getrelai/db";
import { newId } from "../id.js";
import { ensureSubscription, publish } from "../events.js";
import {
  MESSAGE_ROUTER_SYSTEM_PROMPT,
  MESSAGE_ROUTING_TOOL,
  buildMessageRoutingContext,
} from "./message-router-prompt.js";

const ONLINE_WINDOW_MS = 10 * 60 * 1000;

type Agent = typeof agentsTable.$inferSelect;
type Message = typeof messagesTable.$inferSelect;

export interface MessageLoopDeps {
  db: Db;
  anthropic: Anthropic | null;
  model: string;
}

function isOnline(lastSeenAt: Date | string): boolean {
  const ts = lastSeenAt instanceof Date ? lastSeenAt.getTime() : new Date(lastSeenAt).getTime();
  return Date.now() - ts < ONLINE_WINDOW_MS;
}

// ── Helpers that mirror what the routes do, scoped to message-loop's needs ───

async function markThreadRead(db: Db, threadId: string, agentId: string): Promise<void> {
  await db
    .update(messagesTable)
    .set({ readBy: sql`array_append(read_by, ${agentId})` })
    .where(eq(messagesTable.threadId, threadId));
}

async function getOnlineWorkers(db: Db, projectId: string): Promise<Agent[]> {
  const all = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.projectId, projectId), eq(agentsTable.role, "worker")));
  return all.filter((a) => isOnline(a.lastSeenAt));
}

async function getActiveTaskCounts(db: Db, projectId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ assignedTo: tasksTable.assignedTo, status: tasksTable.status })
    .from(tasksTable)
    .where(eq(tasksTable.projectId, projectId));
  const counts: Record<string, number> = {};
  for (const r of rows) {
    if (r.assignedTo && (r.status === "assigned" || r.status === "in_progress")) {
      counts[r.assignedTo] = (counts[r.assignedTo] ?? 0) + 1;
    }
  }
  return counts;
}

interface SendArgs {
  threadId:  string;
  fromAgent: string;
  toAgent?:  string;
  type:      "status" | "handoff" | "finding" | "decision" | "question" | "escalation" | "reply";
  body:      string;
  metadata?: Record<string, unknown>;
}

async function sendMessage(db: Db, args: SendArgs): Promise<Message> {
  const [message] = await db.insert(messagesTable).values({
    id:        newId("msg"),
    threadId:  args.threadId,
    fromAgent: args.fromAgent,
    toAgent:   args.toAgent,
    type:      args.type,
    body:      args.body,
    metadata:  args.metadata ?? {},
  }).returning();

  await ensureSubscription(db, args.fromAgent, "thread", args.threadId);
  if (args.toAgent) {
    await ensureSubscription(db, args.toAgent, "thread", args.threadId);
  }

  const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, args.threadId));
  await publish(db, {
    id:         newId("evt"),
    kind:       "message.posted",
    projectId:  thread?.projectId ?? "",
    targetType: "thread",
    targetId:   args.threadId,
    alsoNotify: args.toAgent ? [{ targetType: "agent", targetId: args.toAgent }] : [],
    payload:    { message },
    createdAt:  message.createdAt.toISOString(),
  });

  return message;
}

interface CreateTaskArgs {
  projectId:      string;
  createdBy:      string;
  title:          string;
  description:    string;
  priority?:      "low" | "normal" | "high" | "urgent";
  domains?:       string[];
  specialization?: string | null;
  assignedTo?:    string | null;
  metadata?:      Record<string, unknown>;
}

async function createTask(db: Db, args: CreateTaskArgs) {
  const [task] = await db.insert(tasksTable).values({
    id:             newId("task"),
    projectId:      args.projectId,
    createdBy:      args.createdBy,
    title:          args.title,
    description:    args.description,
    priority:       args.priority ?? "normal",
    domains:        args.domains ?? [],
    specialization: args.specialization ?? null,
    assignedTo:     args.assignedTo ?? null,
    status:         args.assignedTo ? "assigned" : "pending",
    metadata:       args.metadata ?? {},
  }).returning();

  await publish(db, {
    id:         newId("evt"),
    kind:       "task.created",
    projectId:  task.projectId,
    targetType: "task",
    targetId:   task.id,
    alsoNotify: task.assignedTo ? [{ targetType: "agent", targetId: task.assignedTo }] : [],
    payload:    { task },
    createdAt:  task.createdAt.toISOString(),
  });

  return task;
}

// ── Claude classifier for handoff / question / finding ──────────────────────

async function claudeMessageRoute(
  msg: Message,
  workers: Agent[],
  anthropic: Anthropic,
  model: string,
): Promise<Record<string, unknown>> {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system: MESSAGE_ROUTER_SYSTEM_PROMPT,
    tools:   [MESSAGE_ROUTING_TOOL],
    tool_choice: { type: "any" },
    messages: [{
      role: "user",
      content: buildMessageRoutingContext(
        { type: msg.type, fromAgent: msg.fromAgent, body: msg.body, metadata: msg.metadata as Record<string, unknown> },
        workers.map((w) => ({ id: w.id, name: w.name, specialization: w.specialization, domains: w.domains, lastSeenAt: w.lastSeenAt })),
      ),
    }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a message routing decision");
  }
  return toolUse.input as Record<string, unknown>;
}

async function executeClaudeAction(
  deps: MessageLoopDeps,
  projectId: string,
  orchestrator: Agent,
  msg: Message,
  action: Record<string, unknown>,
): Promise<void> {
  switch (action.action) {
    case "create_task":
      await createTask(deps.db, {
        projectId,
        createdBy:      orchestrator.id,
        title:          action.taskTitle as string,
        description:    action.taskDescription as string,
        domains:        (action.taskDomains as string[]) ?? [],
        specialization: action.taskSpecialization as string | undefined,
        priority:       (action.taskPriority as "low" | "normal" | "high" | "urgent") ?? "normal",
        metadata: { sourceThread: msg.threadId, sourceMessage: msg.id, fromAgent: msg.fromAgent },
      });
      console.log(`[message-loop] Created task from ${msg.type}: "${action.taskTitle}"`);
      return;

    case "forward":
      await sendMessage(deps.db, {
        threadId:  msg.threadId,
        fromAgent: orchestrator.id,
        toAgent:   action.toAgent as string,
        type:      msg.type,
        body:      action.messageBody as string,
        metadata:  { forwardedFrom: msg.fromAgent, originalMessage: msg.id },
      });
      console.log(`[message-loop] Forwarded ${msg.type} to agent ${action.toAgent}`);
      return;

    case "broadcast": {
      const online = await getOnlineWorkers(deps.db, projectId);
      for (const a of online) {
        await sendMessage(deps.db, {
          threadId:  msg.threadId,
          fromAgent: orchestrator.id,
          toAgent:   a.id,
          type:      msg.type,
          body:      action.messageBody as string,
          metadata:  { broadcastFrom: msg.fromAgent, originalMessage: msg.id },
        });
      }
      console.log(`[message-loop] Broadcast ${msg.type} to ${online.length} agent(s)`);
      return;
    }

    case "reply":
      await sendMessage(deps.db, {
        threadId:  msg.threadId,
        fromAgent: orchestrator.id,
        toAgent:   msg.fromAgent,
        type:      "reply",
        body:      action.messageBody as string,
      });
      console.log(`[message-loop] Replied to ${msg.type} from ${msg.fromAgent}`);
      return;

    case "log_only":
    default:
      return;
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function handleMessage(
  deps: MessageLoopDeps,
  projectId: string,
  orchestrator: Agent,
  msg: Message,
): Promise<void> {
  // Scope filter: only handle messages addressed to the orchestrator or
  // broadcast (toAgent null/undefined). Never react to our own messages.
  if (msg.toAgent && msg.toAgent !== orchestrator.id) return;
  if (msg.fromAgent === orchestrator.id) return;

  switch (msg.type) {
    case "status":
    case "reply":
      break;

    case "escalation": {
      console.warn(`[message-loop] ESCALATION from=${msg.fromAgent} thread=${msg.threadId}: ${msg.body}`);

      const online = await getOnlineWorkers(deps.db, projectId);
      const counts = await getActiveTaskCounts(deps.db, projectId);

      let seniors = online.filter((a) => a.tier === 2);
      if (seniors.length === 0) seniors = online.filter((a) => a.specialization === "architect");

      if (seniors.length === 0) {
        await sendMessage(deps.db, {
          threadId:  msg.threadId,
          fromAgent: orchestrator.id,
          toAgent:   msg.fromAgent,
          type:      "reply",
          body:      "Escalation received. No senior agent is currently available — surfaced to human operator.",
        });
        break;
      }

      // Pick least-busy senior; alphabetical tiebreak so behaviour is
      // deterministic when counts collide.
      const ranked = seniors
        .map((a) => ({ agent: a, count: counts[a.id] ?? 0 }))
        .sort((a, b) => a.count - b.count || a.agent.id.localeCompare(b.agent.id));
      const senior = ranked[0].agent;

      const task = await createTask(deps.db, {
        projectId,
        createdBy:      orchestrator.id,
        title:          `Escalation from ${msg.fromAgent}`,
        description:    msg.body,
        specialization: "architect",
        priority:       "high",
        assignedTo:     senior.id,
        metadata: {
          sourceThread:        msg.threadId,
          escalatedFrom:       msg.fromAgent,
          escalationMessageId: msg.id,
          originalMetadata:    msg.metadata,
        },
      });

      await sendMessage(deps.db, {
        threadId:  msg.threadId,
        fromAgent: orchestrator.id,
        toAgent:   msg.fromAgent,
        type:      "reply",
        body:      `Escalation received. Created task ${task.id} and assigned to senior agent ${senior.id} for follow-up.`,
      });

      console.log(`[message-loop] Escalation → task ${task.id} assigned to senior ${senior.id}`);
      break;
    }

    case "decision": {
      const online = await getOnlineWorkers(deps.db, projectId);
      for (const a of online) {
        await sendMessage(deps.db, {
          threadId:  msg.threadId,
          fromAgent: orchestrator.id,
          toAgent:   a.id,
          type:      "decision",
          body:      msg.body,
          metadata:  { broadcastFrom: msg.fromAgent, originalMessage: msg.id },
        });
      }
      if (online.length > 0) {
        console.log(`[message-loop] Broadcast decision to ${online.length} agent(s)`);
      }
      break;
    }

    case "handoff":
    case "question":
    case "finding": {
      if (!deps.anthropic) {
        console.warn(`[message-loop] ${msg.type} message ${msg.id} needs Claude routing but ANTHROPIC_API_KEY not set — skipped`);
        break;
      }
      try {
        const workers = await getOnlineWorkers(deps.db, projectId);
        const action = await claudeMessageRoute(msg, workers, deps.anthropic, deps.model);
        await executeClaudeAction(deps, projectId, orchestrator, msg, action);
      } catch (err) {
        console.error(`[message-loop] Claude routing failed for ${msg.type} message ${msg.id}:`, err);
      }
      break;
    }
  }

  await markThreadRead(deps.db, msg.threadId, orchestrator.id);
}

// ── Per-project cycle ────────────────────────────────────────────────────────

export async function findOrchestratorAgent(db: Db, projectId: string): Promise<Agent | null> {
  const [orch] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.projectId, projectId), eq(agentsTable.role, "orchestrator")));
  return orch ?? null;
}

export async function runMessageLoopCycle(deps: MessageLoopDeps, projectId: string): Promise<void> {
  const orchestrator = await findOrchestratorAgent(deps.db, projectId);
  if (!orchestrator) return;

  // Fetch unread messages for the orchestrator across the whole project,
  // matching the GET /messages/unread route's filter.
  const rows = await deps.db
    .select({ messages: messagesTable })
    .from(messagesTable)
    .innerJoin(threadsTable, eq(messagesTable.threadId, threadsTable.id))
    .where(sql`${threadsTable.projectId} = ${projectId} AND NOT (${messagesTable.readBy} @> ARRAY[${orchestrator.id}]::text[])`);

  const inbox = rows.map((r) => r.messages);
  if (inbox.length === 0) return;

  for (const msg of inbox) {
    try {
      await handleMessage(deps, projectId, orchestrator, msg);
    } catch (err) {
      console.error(`[message-loop] handler error for message ${msg.id}:`, err);
    }
  }
}
