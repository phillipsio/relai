import type { Config } from "./config.js";

export class CliApiClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: Pick<Config, "apiUrl" | "apiSecret">) {
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

  createProject(body: { name: string; description?: string }) {
    return this.request<{ id: string; name: string }>("POST", "/projects", body);
  }

  registerAgent(body: { projectId: string; name: string; role: string; specialization?: string; domains: string[] }) {
    return this.request<{ id: string; name: string; specialization?: string }>("POST", "/agents", body);
  }

  getTasks(params: { projectId: string; assignedTo?: string; status?: string }) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null) as [string, string][]
    );
    return this.request<TaskRow[]>("GET", `/tasks?${qs}`);
  }

  updateTask(id: string, body: { status?: string; metadata?: Record<string, unknown> }) {
    return this.request<TaskRow>("PUT", `/tasks/${id}`, body);
  }

  listThreads(projectId: string) {
    return this.request<ThreadRow[]>("GET", `/threads?projectId=${encodeURIComponent(projectId)}`);
  }

  createThread(body: { projectId: string; title: string }) {
    return this.request<ThreadRow>("POST", "/threads", body);
  }

  sendMessage(threadId: string, body: {
    fromAgent: string;
    toAgent?: string;
    type: string;
    body: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.request<MessageRow>("POST", `/threads/${threadId}/messages`, body);
  }

  getUnread(agentId: string) {
    return this.request<MessageRow[]>("GET", `/messages/unread?agentId=${encodeURIComponent(agentId)}`);
  }

  markRead(threadId: string, agentId: string) {
    return this.request<unknown>("PUT", `/threads/${threadId}/messages/read`, { agentId });
  }

  getAgents(projectId: string) {
    return this.request<AgentRow[]>("GET", `/agents?projectId=${encodeURIComponent(projectId)}`);
  }

  heartbeat(agentId: string) {
    return this.request<unknown>("PUT", `/agents/${agentId}/heartbeat`, {});
  }
}

// Minimal row types for display
export interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  domains: string[];
  assignedTo?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadRow {
  id: string;
  title: string;
  projectId: string;
  createdAt: string;
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
  readBy: string[];
}

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  specialization?: string | null;
  domains: string[];
  lastSeenAt: string;
}
