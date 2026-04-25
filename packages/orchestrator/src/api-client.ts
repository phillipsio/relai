import type { OrchestratorConfig } from "./config.js";

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  domains: string[];
  specialization?: string | null;
  assignedTo?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  specialization?: string | null;
  tier?: number | null;
  domains: string[];
  lastSeenAt: string;
}

export interface MessageRow {
  id: string;
  threadId: string;
  fromAgent: string;
  toAgent?: string;
  type: string;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export class OrchestratorApiClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: Pick<OrchestratorConfig, "apiUrl" | "apiSecret">) {
    this.baseUrl = config.apiUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiSecret}`,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const json = await res.json() as { data?: T; error?: { code: string; message: string } };
    if (!res.ok) throw new Error(json.error?.message ?? `API error ${res.status}`);
    return json.data as T;
  }

  getPendingTasks(projectId: string) {
    return this.request<TaskRow[]>("GET", `/tasks?projectId=${encodeURIComponent(projectId)}&status=pending`);
  }

  getBlockedTasks(projectId: string) {
    return this.request<TaskRow[]>("GET", `/tasks?projectId=${encodeURIComponent(projectId)}&status=blocked`);
  }

  getThreadMessages(threadId: string) {
    return this.request<MessageRow[]>("GET", `/threads/${threadId}/messages`);
  }

  resumeTask(taskId: string, metadata: Record<string, unknown>) {
    return this.request<TaskRow>("PUT", `/tasks/${taskId}`, { status: "assigned", metadata });
  }

  assignTask(taskId: string, agentId: string) {
    return this.request<TaskRow>("PUT", `/tasks/${taskId}`, {
      status: "assigned",
      assignedTo: agentId,
    });
  }

  getWorkerAgents(projectId: string): Promise<AgentRow[]> {
    return this.request<AgentRow[]>("GET", `/agents?projectId=${encodeURIComponent(projectId)}`).then(
      (agents) => agents.filter((a) => a.role === "worker")
    );
  }

  getUnreadEscalations(agentId: string, projectId: string): Promise<MessageRow[]> {
    return this.request<MessageRow[]>("GET", `/messages/unread?agentId=${encodeURIComponent(agentId)}&projectId=${encodeURIComponent(projectId)}`).then(
      (messages) => messages.filter((m) => m.type === "escalation")
    );
  }

  getUnreadMessages(agentId: string, projectId: string): Promise<MessageRow[]> {
    return this.request<MessageRow[]>("GET", `/messages/unread?agentId=${encodeURIComponent(agentId)}&projectId=${encodeURIComponent(projectId)}`);
  }

  sendMessage(threadId: string, body: {
    fromAgent: string;
    toAgent?: string;
    type: string;
    body: string;
    metadata?: Record<string, unknown>;
  }): Promise<MessageRow> {
    return this.request<MessageRow>("POST", `/threads/${threadId}/messages`, body);
  }

  createTask(body: {
    projectId: string;
    createdBy: string;
    title: string;
    description: string;
    priority?: string;
    domains?: string[];
    specialization?: string;
    metadata?: Record<string, unknown>;
  }): Promise<TaskRow> {
    return this.request<TaskRow>("POST", "/tasks", body);
  }

  async getActiveTaskCounts(projectId: string): Promise<Record<string, number>> {
    const inProgress = await this.request<TaskRow[]>("GET", `/tasks?projectId=${encodeURIComponent(projectId)}&status=in_progress`);
    const counts: Record<string, number> = {};
    for (const t of inProgress) {
      if (t.assignedTo) counts[t.assignedTo] = (counts[t.assignedTo] ?? 0) + 1;
    }
    return counts;
  }

  markRead(threadId: string, agentId: string) {
    return this.request<unknown>("PUT", `/threads/${threadId}/messages/read`, { agentId });
  }

  heartbeat(agentId: string) {
    return this.request<unknown>("PUT", `/agents/${agentId}/heartbeat`, {});
  }

  logRouting(body: {
    taskId: string;
    assignedTo: string;
    method: "rules" | "claude";
    rationale: string;
  }) {
    return this.request<unknown>("POST", "/routing-log", body);
  }
}
