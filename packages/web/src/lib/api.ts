import type { WebConfig } from "./config";

export interface RepoRow {
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
  threadId?: string | null;
  epicId?: string | null;
  metadata?: Record<string, unknown>;
}
export interface AgentRow {
  id: string; name: string; role: string; specialization?: string | null;
  tier?: number | null; domains: string[]; workerType?: string | null;
  repoPath?: string | null; lastSeenAt: string;
}
export interface ThreadRow {
  id: string; title: string; repoId: string;
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
  public repoId: string;
  public readonly apiUrl: string;
  public readonly apiSecret: string;

  constructor(config: WebConfig) {
    this.baseUrl = config.apiUrl.replace(/\/$/, "");
    this.repoId = config.repoId;
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

  getRepos()  { return this.request<RepoRow[]>("GET", "/repos"); }
  createRepo(name: string, description?: string, defaultAssignee?: string) {
    return this.request<RepoRow>("POST", "/repos", { name, description, defaultAssignee });
  }
  deleteRepo(id: string) { return this.request<void>("DELETE", `/repos/${id}`); }

  createTask(body: { title: string; description: string; specialization?: string; domains?: string[]; priority?: string; assignedTo?: string; epicId?: string; metadata?: Record<string, unknown> }) {
    return this.request<TaskRow>("POST", "/tasks", { ...body, repoId: this.repoId, createdBy: "human" });
  }
  updateTask(id: string, body: { status?: string; assignedTo?: string | null; epicId?: string | null; priority?: string }) {
    return this.request<TaskRow>("PUT", `/tasks/${id}`, body);
  }
  submitReview(id: string, body: { decision: "approve" | "reject"; note?: string }) {
    return this.request<TaskRow>("POST", `/tasks/${id}/review`, body);
  }
  // Commit (or reject) a worker's "proposed" Issue. Admin path acts as orchestrator.
  commitTask(id: string, body: { decision?: "commit" | "reject"; assignedTo?: string; note?: string; epicId?: string; priority?: string; title?: string }) {
    return this.request<TaskRow>("POST", `/tasks/${id}/commit`, body);
  }
  // An Issue's comments live on its lazily-created thread.
  getTaskComments(id: string) {
    return this.request<{ threadId: string; comments: MessageRow[] }>("GET", `/tasks/${id}/comments`);
  }
  postTaskComment(id: string, body: string, type?: string) {
    return this.request<MessageRow>("POST", `/tasks/${id}/comments`, { body, type });
  }

  getAgents()  { return this.request<AgentRow[]>("GET", `/agents?repoId=${encodeURIComponent(this.repoId)}`); }
  deleteAgent(id: string) { return this.request<void>("DELETE", `/agents/${id}`); }
  createAgent(body: { name: string; role?: "orchestrator" | "worker"; tier?: number; specialization?: string; domains?: string[]; workerType?: string; repoPath?: string }) {
    return this.request<AgentRow>("POST", "/agents", {
      ...body,
      repoId: this.repoId,
      role: body.role ?? "worker",
    });
  }
  getTasks(status?: string, epicId?: string) {
    const qs = new URLSearchParams({ repoId: this.repoId });
    if (status) qs.set("status", status);
    if (epicId) qs.set("epicId", epicId);
    return this.request<TaskRow[]>("GET", `/tasks?${qs}`);
  }
  getThreads(type?: string) {
    const qs = new URLSearchParams({ repoId: this.repoId });
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
    return this.request<ThreadRow>("POST", "/threads", { repoId: this.repoId, title, type: "plan" });
  }
  getMessages(threadId: string) { return this.request<MessageRow[]>("GET", `/threads/${threadId}/messages`); }
  sendMessage(threadId: string, body: string) {
    return this.request<MessageRow>("POST", `/threads/${threadId}/messages`, {
      fromAgent: "human", type: "reply", body,
    });
  }
}
