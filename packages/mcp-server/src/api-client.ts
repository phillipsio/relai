// Thin HTTP client for the ai-orchestrator API.
// The MCP server never touches the DB directly — everything goes through the API.

export interface ApiClientConfig {
  baseUrl: string;
  secret: string;
}

export class ApiClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.secret}`,
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

  // Tasks
  getTasks(params: { projectId?: string; status?: string; assignedTo?: string }) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]);
    return this.request<unknown[]>("GET", `/tasks?${qs}`);
  }

  getTask(id: string) {
    return this.request<unknown>("GET", `/tasks/${id}`);
  }

  createTask(body: {
    projectId: string;
    createdBy: string;
    title: string;
    description: string;
    priority?: string;
    domains?: string[];
    metadata?: Record<string, unknown>;
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

  getUnread(agentId: string, projectId: string) {
    return this.request<unknown[]>("GET", `/messages/unread?agentId=${encodeURIComponent(agentId)}&projectId=${encodeURIComponent(projectId)}`);
  }

  markRead(threadId: string, agentId: string) {
    return this.request<unknown>("PUT", `/threads/${threadId}/messages/read`, { agentId });
  }

  // Agents
  registerAgent(body: { projectId: string; name: string; role: string; domains?: string[] }) {
    return this.request<unknown>("POST", "/agents", body);
  }

  heartbeat(agentId: string) {
    return this.request<unknown>("PUT", `/agents/${agentId}/heartbeat`, {});
  }

  listAgents(projectId: string) {
    return this.request<unknown[]>("GET", `/agents?projectId=${encodeURIComponent(projectId)}`);
  }

  // Threads
  createThread(body: { projectId: string; title: string; type?: string }) {
    return this.request<unknown>("POST", "/threads", body);
  }

  listThreads(projectId: string, type?: string) {
    const qs = new URLSearchParams({ projectId });
    if (type) qs.set("type", type);
    return this.request<unknown[]>("GET", `/threads?${qs}`);
  }

  concludePlan(threadId: string, summary?: string) {
    return this.request<unknown>("PUT", `/threads/${threadId}/conclude`, { summary });
  }
}
