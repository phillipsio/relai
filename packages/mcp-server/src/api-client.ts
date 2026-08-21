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

  // For routes with sibling fields next to `data` (e.g. the unread feed's
  // `meta.total`, which says how much the cap hid).
  private async requestEnvelope<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data?: T; meta?: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json() as { data?: T; meta?: Record<string, unknown>; error?: { code: string; message: string } };
    if (!res.ok) {
      throw new Error(json.error?.message ?? `API error ${res.status}`);
    }
    return json;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const json = await this.requestEnvelope<T>(method, path, body);
    return json.data as T;
  }

  // Repos
  getRepo(id: string) {
    return this.request<{ id: string; repoUrl?: string | null }>("GET", `/repos/${id}`);
  }

  listRepos() {
    return this.request<unknown[]>("GET", "/repos");
  }

  // Artifacts
  publishArtifact(body: {
    repoId: string; name: string; body: string; description?: string;
    contentType?: string; visibility?: string; taskId?: string; metadata?: Record<string, unknown>;
  }) {
    return this.request<{ artifact: { id: string; name: string }; version: { version: number } }>(
      "POST", "/artifacts", body,
    );
  }

  getArtifact(repoId: string, name: string, version?: number) {
    const qs = new URLSearchParams({ repoId, ...(version ? { version: String(version) } : {}) });
    return this.request<{
      artifact: { name: string; description: string | null; ownerAgentId: string | null };
      version: { version: number; body: string; contentType: string; createdAt: string };
    }>("GET", `/artifacts/${encodeURIComponent(name)}?${qs}`);
  }

  listArtifacts(repoId: string) {
    return this.request<Array<{ name: string; description: string | null; currentVersion: number }>>(
      "GET", `/artifacts?repoId=${encodeURIComponent(repoId)}`,
    );
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

  directMessage(toAgentId: string, body: {
    type: string;
    body: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.request<{ threadId: string; message: unknown }>("POST", `/agents/${toAgentId}/messages`, body);
  }

  getMessages(threadId: string) {
    return this.request<unknown[]>("GET", `/threads/${threadId}/messages`);
  }

  // Envelope, not just rows: meta.total is how many unread exist versus how
  // many the cap returned, and hiding that difference misleads the reader.
  getUnread(agentId: string, repoId: string) {
    const qs = `agentId=${encodeURIComponent(agentId)}&repoId=${encodeURIComponent(repoId)}`;
    return this.requestEnvelope<unknown[]>("GET", `/messages/unread?${qs}`);
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

  // repoId optional: omitted, the API scopes to the caller's owned repos, which
  // is what an operator with no single repo needs.
  listThreads(repoId?: string, type?: string) {
    const qs = new URLSearchParams();
    if (repoId) qs.set("repoId", repoId);
    if (type)   qs.set("type", type);
    const suffix = qs.toString() ? `?${qs}` : "";
    return this.request<unknown[]>("GET", `/threads${suffix}`);
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
