"use strict";
// Thin HTTP client for the ai-orchestrator API.
// The MCP server never touches the DB directly — everything goes through the API.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiClient = void 0;
class ApiClient {
    baseUrl;
    headers;
    constructor(config) {
        this.baseUrl = config.baseUrl.replace(/\/$/, "");
        this.headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.secret}`,
            ...(config.ownerId ? { "X-Owner-Id": config.ownerId } : {}),
        };
    }
    async request(method, path, body) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: this.headers,
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json();
        if (!res.ok) {
            throw new Error(json.error?.message ?? `API error ${res.status}`);
        }
        return json.data;
    }
    // Repos
    getRepo(id) {
        return this.request("GET", `/repos/${id}`);
    }
    // Tasks
    getTasks(params) {
        const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null));
        return this.request("GET", `/tasks?${qs}`);
    }
    getTask(id) {
        return this.request("GET", `/tasks/${id}`);
    }
    createTask(body) {
        return this.request("POST", "/tasks", body);
    }
    updateTask(id, body) {
        return this.request("PUT", `/tasks/${id}`, body);
    }
    submitReview(taskId, body) {
        return this.request("POST", `/tasks/${taskId}/review`, body);
    }
    // Orchestrator-only: commit a proposed task into the lifecycle, or reject it.
    commitTask(taskId, body) {
        return this.request("POST", `/tasks/${taskId}/commit`, body);
    }
    // Messages
    sendMessage(threadId, body) {
        return this.request("POST", `/threads/${threadId}/messages`, body);
    }
    getMessages(threadId) {
        return this.request("GET", `/threads/${threadId}/messages`);
    }
    getUnread(agentId, repoId) {
        return this.request("GET", `/messages/unread?agentId=${encodeURIComponent(agentId)}&repoId=${encodeURIComponent(repoId)}`);
    }
    markRead(threadId, agentId) {
        return this.request("PUT", `/threads/${threadId}/messages/read`, { agentId });
    }
    // Agents
    registerAgent(body) {
        return this.request("POST", "/agents", body);
    }
    heartbeat(agentId) {
        return this.request("PUT", `/agents/${agentId}/heartbeat`, {});
    }
    listAgents(repoId) {
        return this.request("GET", `/agents?repoId=${encodeURIComponent(repoId)}`);
    }
    // Threads
    createThread(body) {
        return this.request("POST", "/threads", body);
    }
    listThreads(repoId, type) {
        const qs = new URLSearchParams({ repoId });
        if (type)
            qs.set("type", type);
        return this.request("GET", `/threads?${qs}`);
    }
    concludePlan(threadId, summary) {
        return this.request("PUT", `/threads/${threadId}/conclude`, { summary });
    }
    // Session
    getSessionStart(repoId) {
        const qs = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
        return this.request("GET", `/session/start${qs}`);
    }
}
exports.ApiClient = ApiClient;
//# sourceMappingURL=api-client.js.map