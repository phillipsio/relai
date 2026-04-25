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
    // Messages
    sendMessage(threadId, body) {
        return this.request("POST", `/threads/${threadId}/messages`, body);
    }
    getMessages(threadId) {
        return this.request("GET", `/threads/${threadId}/messages`);
    }
    getUnread(agentId, projectId) {
        return this.request("GET", `/messages/unread?agentId=${encodeURIComponent(agentId)}&projectId=${encodeURIComponent(projectId)}`);
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
    listAgents(projectId) {
        return this.request("GET", `/agents?projectId=${encodeURIComponent(projectId)}`);
    }
    // Threads
    createThread(body) {
        return this.request("POST", "/threads", body);
    }
    listThreads(projectId, type) {
        const qs = new URLSearchParams({ projectId });
        if (type)
            qs.set("type", type);
        return this.request("GET", `/threads?${qs}`);
    }
    concludePlan(threadId, summary) {
        return this.request("PUT", `/threads/${threadId}/conclude`, { summary });
    }
}
exports.ApiClient = ApiClient;
//# sourceMappingURL=api-client.js.map