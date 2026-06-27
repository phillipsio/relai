// Thin HTTP client for the ai-orchestrator API.
// The MCP server never touches the DB directly — everything goes through the API.

export interface ApiClientConfig {
  baseUrl: string;
  secret: string;
  // When set, the client authenticates as the cross-project owner: `secret` is
  // the service-admin token and this id is sent as X-Owner-Id, so API handlers
  // scope reads/writes to this owner's projects (see api/src/plugins/auth.ts).
  ownerId?: string;
}

export class ApiClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.secret}`,
      ...(config.ownerId ? { "X-Owner-Id": config.ownerId } : {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json() as { data?: T; error?: { code: string; message: string } };
    if (!res.ok) {
      throw new Error(json.error?.message ?? `API error ${res.status}`);
    }
    return json.data as T;
  }

  // Repos
  getRepo(id: string) {
    return this.request<{ id: string; repoUrl?: string | null }>("GET", `/repos/${id}`);
  }

  listRepos() {
    return this.request<unknown[]>("GET", "/repos");
  }

  // Tasks
  getTasks(params: { repoId?: string; status?: string; assignedTo?: string }) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]);
    return this.request<unknown[]>("GET", `/tasks?${qs}`);
  }

  getTask(id: string) {
    return this.request<unknown>("GET", `/tasks/${id}`);
  }

  createTask(body: {
    repoId: string;
    createdBy: string;
    title: string;
    description: string;
    priority?: string;
    assignedTo?: string;
    domains?: string[];
    specialization?: string;
    metadata?: Record<string, unknown>;
    // Verification predicate (optional). Shell is orchestrator-gated server-side.
    verifyKind?: string;
    verifyReviewerId?: string;
    verifyThreadId?: string;
    verifyPath?: string;
    verifyCommand?: string;
    verifyCwd?: string;
    verifyTimeoutMs?: number;
  }) {
    return this.request<unknown>("POST", "/tasks", body);
  }

  updateTask(id: string, body: {
    status?: string;
    assignedTo?: string | null;
    priority?: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.request<unknown>("PUT", `/tasks/${id}`, body);
  }

  submitReview(taskId: string, body: { decision: "approve" | "reject"; note?: string }) {
    return this.request<unknown>("POST", `/tasks/${taskId}/review`, body);
  }

  // Orchestrator-only: commit a proposed task into the lifecycle, or reject it.
  commitTask(taskId: string, body: {
    decision?: "commit" | "reject";
    assignedTo?: string;
    note?: string;
    title?: string;
    description?: string;
    priority?: string;
    domains?: string[];
    specialization?: string;
    verifyKind?: string;
    verifyReviewerId?: string;
    verifyThreadId?: string;
    verifyPath?: string;
    verifyCommand?: string;
    verifyCwd?: string;
    verifyTimeoutMs?: number;
  }) {
    return this.request<unknown>("POST", `/tasks/${taskId}/commit`, body);
  }

  // Messages
  sendMessage(threadId: string, body: {
    fromAgent: string;
    toAgent?: string;
    type: string;
    body: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.request<unknown>("POST", `/threads/${threadId}/messages`, body);
  }

  getMessages(threadId: string) {
    return this.request<unknown[]>("GET", `/threads/${threadId}/messages`);
  }

  getUnread(agentId: string, repoId: string) {
    return this.request<unknown[]>("GET", `/messages/unread?agentId=${encodeURIComponent(agentId)}&repoId=${encodeURIComponent(repoId)}`);
  }

  markRead(threadId: string, agentId: string) {
    return this.request<unknown>("PUT", `/threads/${threadId}/messages/read`, { agentId });
  }

  // Agents
  registerAgent(body: { repoId: string; name: string; role: string; domains?: string[] }) {
    return this.request<unknown>("POST", "/agents", body);
  }

  heartbeat(agentId: string) {
    return this.request<unknown>("PUT", `/agents/${agentId}/heartbeat`, {});
  }

  listAgents(repoId?: string) {
    const qs = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
    return this.request<unknown[]>("GET", `/agents${qs}`);
  }

  getTaskComments(taskId: string) {
    return this.request<unknown>("GET", `/tasks/${taskId}/comments`);
  }

  addTaskComment(taskId: string, body: { body: string; type?: string }) {
    return this.request<unknown>("POST", `/tasks/${taskId}/comments`, body);
  }

  reportFeedback(body: { summary: string; details: string; severity?: string }) {
    return this.request<unknown>("POST", "/relai-feedback", body);
  }

  // Threads
  createThread(body: { repoId: string; title: string; type?: string }) {
    return this.request<unknown>("POST", "/threads", body);
  }

  listThreads(repoId: string, type?: string) {
    const qs = new URLSearchParams({ repoId });
    if (type) qs.set("type", type);
    return this.request<unknown[]>("GET", `/threads?${qs}`);
  }

  concludePlan(threadId: string, summary?: string) {
    return this.request<unknown>("PUT", `/threads/${threadId}/conclude`, { summary });
  }

  // Pass an empty body so the always-present Content-Type: application/json
  // header has valid JSON to parse (Fastify 400s on an empty json body).
  archiveTask(taskId: string) {
    return this.request<unknown>("PUT", `/tasks/${taskId}/archive`, {});
  }

  archiveThread(threadId: string) {
    return this.request<unknown>("PUT", `/threads/${threadId}/archive`, {});
  }

  // Session
  getSessionStart(repoId?: string) {
    const qs = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
    return this.request<Record<string, unknown>>("GET", `/session/start${qs}`);
  }
}
