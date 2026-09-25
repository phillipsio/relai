// Agent identity
export type AgentId = string;

export type AgentRole = "orchestrator" | "worker";

export interface Agent {
  id: AgentId;
  name: string;
  role: AgentRole;
  domains: string[];       // e.g. ["frontend", "auth"] or ["backend", "observability"]
  connectedAt: Date;
  lastSeenAt: Date;
}

// Task lifecycle
export type TaskStatus = "proposed" | "pending" | "assigned" | "in_progress" | "pending_verification" | "completed" | "blocked" | "cancelled";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface Task {
  id: string;
  repoId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  domains: string[];
  assignedTo?: AgentId;
  createdBy: AgentId;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// Message types — the atomic unit of agent coordination
export type MessageType =
  | "status"       // routine progress update
  | "handoff"      // "I finished X, here's what you need next"
  | "finding"      // "I discovered something relevant to the project"
  | "decision"     // "We agreed on X — both agents should honor this"
  | "question"     // "Blocked, need context before proceeding"
  | "escalation"   // "Needs human judgment"
  | "reply";       // response to any of the above

export interface Message {
  id: string;
  threadId: string;
  fromAgent: AgentId;
  toAgent?: AgentId;       // undefined = broadcast to orchestrator
  type: MessageType;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  readBy: AgentId[];
}

export interface Thread {
  id: string;
  repoId: string;
  title: string;
  createdAt: Date;
}

// Routing
export type RoutingMethod = "rules" | "claude";  // rules = free, claude = costs tokens

export interface RoutingDecision {
  taskId: string;
  assignedTo: AgentId;
  method: RoutingMethod;
  rationale: string;
}

// Repos
export interface Repo {
  id: string;
  name: string;
  repoUrl?: string;
  description?: string;
  createdAt: Date;
}

// User-facing task label — verb-first, framed as "what does the human need to do
// next" rather than the agent-state framing of TaskStatus. Derived from status
// plus a couple of flags; intended for CLI/UI surfaces, never persisted.
export type TaskHumanLabel =
  | "Proposed"        // proposed — awaiting an orchestrator's commit
  | "Queued"          // pending, autoAssign true — awaiting routing
  | "Unassigned"      // pending, no assignee and no autoAssign
  | "Starting"        // assigned, not yet picked up
  | "Not picked up"   // assigned, and nothing has touched it since
  | "Running"         // in_progress
  | "Stalled"         // in_progress with stalledAt set
  | "Verifying"       // pending_verification — predicate scheduled
  | "Input required"  // blocked
  | "Done"            // completed
  | "Cancelled";      // cancelled

// No scheduler watches this state; detectStalls scans only `in_progress`.
export const DEFAULT_UNSTARTED_AFTER_MS = 4 * 60 * 60 * 1000;

export function humanizeTaskStatus(
  task: {
    status: TaskStatus;
    autoAssign?: boolean;
    assignedTo?: string | null;
    stalledAt?: Date | string | null;
    updatedAt?: Date | string | null;
  },
  opts: { unstartedAfterMs?: number } = {},
): TaskHumanLabel {
  switch (task.status) {
    case "proposed":    return "Proposed";
    case "pending":     return task.autoAssign ? "Queued" : "Unassigned";
    case "assigned":    return unstarted(task, opts) ? "Not picked up" : "Starting";
    case "in_progress": return task.stalledAt ? "Stalled" : "Running";
    case "pending_verification": return "Verifying";
    case "blocked":     return "Input required";
    case "completed":   return "Done";
    case "cancelled":   return "Cancelled";
  }
}

// Fails closed on a missing or unparseable timestamp, because NaN >= n is false.
function unstarted(
  task: { updatedAt?: Date | string | null },
  opts: { unstartedAfterMs?: number },
): boolean {
  if (!task.updatedAt) return false;
  return Date.now() - new Date(task.updatedAt).getTime() >= (opts.unstartedAfterMs ?? DEFAULT_UNSTARTED_AFTER_MS);
}
