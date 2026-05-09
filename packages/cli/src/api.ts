import type { Config } from "./config.js";

export class CliApiClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: { apiUrl: string; apiToken?: string }) {
    this.baseUrl = config.apiUrl.replace(/\/$/, "");
    this.headers = { "Content-Type": "application/json" };
    if (config.apiToken) this.headers.Authorization = `Bearer ${config.apiToken}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const json = await this.requestRaw<{ data?: T; error?: { code: string; message: string } }>(method, path, body);
    return json.data as T;
  }

  private async requestRaw<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const json = await res.json() as T & { error?: { code: string; message: string } };
    if (!res.ok) throw new Error(json.error?.message ?? `API error ${res.status}`);
    return json;
  }

  createProject(body: { name: string; description?: string }) {
    return this.request<{ id: string; name: string }>("POST", "/projects", body);
  }

  listProjects() {
    return this.request<ProjectRow[]>("GET", "/projects");
  }

  getProject(id: string) {
    return this.request<ProjectRow>("GET", `/projects/${id}`);
  }

  updateProject(id: string, body: Partial<Pick<ProjectRow, "name" | "description" | "repoUrl" | "defaultAssignee" | "context">>) {
    return this.request<ProjectRow>("PUT", `/projects/${id}`, body);
  }

  createTask(body: {
    projectId: string;
    createdBy: string;
    title: string;
    description: string;
    priority?: "low" | "normal" | "high" | "urgent";
    assignedTo?: string;
    domains?: string[];
    specialization?: string;
    verifyKind?: "shell" | "file_exists" | "thread_concluded" | "reviewer_agent";
    verifyCommand?: string;
    verifyCwd?: string;
    verifyPath?: string;
    verifyThreadId?: string;
    verifyReviewerId?: string;
  }) {
    return this.request<TaskRow>("POST", "/tasks", body);
  }

  async registerAgent(body: { projectId: string; name: string; role: string; specialization?: string; domains: string[] }) {
    const res = await this.requestRaw<{
      data: { id: string; name: string; specialization?: string };
      token: string;
    }>("POST", "/agents", body);
    return { agent: res.data, token: res.token };
  }

  async rotateToken(agentId: string) {
    const res = await this.requestRaw<{ data: { id: string }; token: string }>("POST", `/agents/${agentId}/tokens`, {});
    return { tokenId: res.data.id, token: res.token };
  }

  revokeToken(tokenId: string) {
    return this.requestRaw<void>("DELETE", `/tokens/${tokenId}`);
  }

  async createInvite(projectId: string, body: { suggestedName?: string; suggestedSpecialization?: string; ttlSeconds?: number }) {
    const res = await this.requestRaw<{
      data: { id: string; expiresAt: string; suggestedName?: string | null; suggestedSpecialization?: string | null };
      code: string;
    }>("POST", `/projects/${projectId}/invites`, body);
    return { invite: res.data, code: res.code };
  }

  async acceptInvite(body: {
    code: string;
    name: string;
    role?: "orchestrator" | "worker";
    specialization?: string;
    workerType?: string;
    domains?: string[];
  }) {
    const res = await this.requestRaw<{
      data: { id: string; name: string; projectId: string; specialization?: string | null };
      token: string;
    }>("POST", "/auth/accept-invite", body);
    return { agent: res.data, token: res.token };
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

  submitReview(id: string, body: { decision: "approve" | "reject"; note?: string }) {
    return this.request<TaskRow>("POST", `/tasks/${id}/review`, body);
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

  getUnread(agentId: string, projectId: string) {
    const qs = new URLSearchParams({ agentId, projectId });
    return this.request<MessageRow[]>("GET", `/messages/unread?${qs}`);
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

  getSessionStart(projectId?: string) {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return this.request<SessionStart>("GET", `/session/start${qs}`);
  }
}

export interface SessionStart {
  agent: {
    id: string;
    name: string;
    specialization: string | null;
    workerType: string | null;
    repoPath: string | null;
  };
  project: {
    id: string;
    name: string;
    context: string | null;
    defaultAssignee: string | null;
  };
  tasks: Array<TaskRow & {
    humanLabel: "Queued" | "Unassigned" | "Starting" | "Running" | "Stalled" | "Input required" | "Done" | "Cancelled";
    stalledAt?: string | null;
  }>;
  unreadMessages: MessageRow[];
  openThreads: ThreadRow[];
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

export interface ProjectRow {
  id: string;
  name: string;
  description?: string | null;
  repoUrl?: string | null;
  defaultAssignee?: string | null;
  context?: string | null;
  createdAt: string;
}
