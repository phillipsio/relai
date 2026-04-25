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
export type TaskStatus = "pending" | "assigned" | "in_progress" | "completed" | "blocked" | "cancelled";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface Task {
  id: string;
  projectId: string;
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
  projectId: string;
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

// Projects
export interface Project {
  id: string;
  name: string;
  repoUrl?: string;
  description?: string;
  createdAt: Date;
}
