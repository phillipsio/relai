import type { WebConfig } from "./config";

export interface ProjectRow {
  id: string; name: string; description?: string | null; repoUrl?: string | null;
  defaultAssignee?: string | null; createdAt: string;
}
export interface TaskRow {
  id: string; title: string; description: string;
  status: string; priority: string; domains: string[];
  specialization?: string | null;
  assignedTo?: string; createdAt: string; updatedAt: string;
  verifyKind?: string | null;
  verifyReviewerId?: string | null;
  metadata?: Record<string, unknown>;
}
export interface AgentRow {
  id: string; name: string; role: string; specialization?: string | null;
  tier?: number | null; domains: string[]; workerType?: string | null;
  repoPath?: string | null; lastSeenAt: string;
}
export interface ThreadRow {
  id: string; title: string; projectId: string;
  type?: string | null; status: string; summary?: string | null;
  createdAt: string; messageCount: number;
}
export interface MessageRow {
  id: string; threadId: string; fromAgent: string; toAgent?: string;
  type: string; body: string; metadata: Record<string, unknown>;
  createdAt: string; readBy: string[];
}

export class WebApiClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  public projectId: string;
  public readonly apiUrl: string;
  public readonly apiSecret: string;

  constructor(config: WebConfig) {
    this.baseUrl = config.apiUrl.replace(/\/$/, "");
    this.projectId = config.projectId;
    this.apiUrl = config.apiUrl;
    this.apiSecret = config.apiSecret;
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiSecret}`,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method, headers: this.headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const json = await res.json() as { data?: T; error?: { code: string; message: string } };
    if (!res.ok) throw new Error(json.error?.message ?? `API error ${res.status}`);
    return json.data as T;
  }

  getProjects()  { return this.request<ProjectRow[]>("GET", "/projects"); }
  createProject(name: string, description?: string, defaultAssignee?: string) {
    return this.request<ProjectRow>("POST", "/projects", { name, description, defaultAssignee });
  }
  deleteProject(id: string) { return this.request<void>("DELETE", `/projects/${id}`); }

  createTask(body: { title: string; description: string; specialization?: string; domains?: string[]; priority?: string; assignedTo?: string; metadata?: Record<string, unknown> }) {
    return this.request<TaskRow>("POST", "/tasks", { ...body, projectId: this.projectId, createdBy: "human" });
  }
  updateTask(id: string, body: { status?: string; assignedTo?: string | null }) {
    return this.request<TaskRow>("PUT", `/tasks/${id}`, body);
  }
  submitReview(id: string, body: { decision: "approve" | "reject"; note?: string }) {
    return this.request<TaskRow>("POST", `/tasks/${id}/review`, body);
  }

  getAgents()  { return this.request<AgentRow[]>("GET", `/agents?projectId=${encodeURIComponent(this.projectId)}`); }
  deleteAgent(id: string) { return this.request<void>("DELETE", `/agents/${id}`); }
  createAgent(body: { name: string; role?: "orchestrator" | "worker"; tier?: number; specialization?: string; domains?: string[]; workerType?: string; repoPath?: string }) {
    return this.request<AgentRow>("POST", "/agents", {
      ...body,
      projectId: this.projectId,
      role: body.role ?? "worker",
    });
  }
  getTasks(status?: string) {
    const qs = new URLSearchParams({ projectId: this.projectId });
    if (status) qs.set("status", status);
    return this.request<TaskRow[]>("GET", `/tasks?${qs}`);
  }
  getThreads(type?: string) {
    const qs = new URLSearchParams({ projectId: this.projectId });
    if (type) qs.set("type", type);
    return this.request<ThreadRow[]>("GET", `/threads?${qs}`);
  }
  concludePlan(threadId: string, summary?: string) {
    return this.request<ThreadRow>("PUT", `/threads/${threadId}/conclude`, { summary });
  }
  deleteThread(threadId: string) {
    return this.request<void>("DELETE", `/threads/${threadId}`);
  }
  createPlan(title: string) {
    return this.request<ThreadRow>("POST", "/threads", { projectId: this.projectId, title, type: "plan" });
  }
  getMessages(threadId: string) { return this.request<MessageRow[]>("GET", `/threads/${threadId}/messages`); }
  sendMessage(threadId: string, body: string) {
    return this.request<MessageRow>("POST", `/threads/${threadId}/messages`, {
      fromAgent: "human", type: "reply", body,
    });
  }
}
