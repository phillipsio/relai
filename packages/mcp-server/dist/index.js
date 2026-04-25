#!/usr/bin/env node
"use strict";
// ai-orchestrator MCP server
// Supports two transports:
//   stdio (default) — Claude Code, Copilot in VS Code, any local MCP client
//   http            — remote/team scenarios; set TRANSPORT=http
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const api_client_js_1 = require("./api-client.js");
const tools_js_1 = require("./tools.js");
const { API_URL = process.env.ORCHESTRATOR_API_URL ?? "http://localhost:3010", API_SECRET = process.env.ORCHESTRATOR_API_SECRET, AGENT_ID, PROJECT_ID, TRANSPORT = "stdio", } = process.env;
if (!API_SECRET) {
    console.error("[relai-mcp] API_SECRET is required");
    process.exit(1);
}
if (!AGENT_ID) {
    console.error("[relai-mcp] AGENT_ID is required — register your agent first and pass its ID here");
    process.exit(1);
}
if (!PROJECT_ID) {
    console.error("[relai-mcp] PROJECT_ID is required");
    process.exit(1);
}
const apiClient = new api_client_js_1.ApiClient({
    baseUrl: API_URL,
    secret: API_SECRET,
});
const server = new mcp_js_1.McpServer({
    name: "relai",
    version: "0.1.0",
});
// Register all tools
const tools = (0, tools_js_1.buildTools)(apiClient, AGENT_ID, PROJECT_ID);
for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.inputSchema.shape, tool.handler);
}
// Start heartbeat — keeps agent "online" in the project without Claude calls
const HEARTBEAT_INTERVAL_MS = 60_000;
setInterval(() => {
    apiClient.heartbeat(AGENT_ID).catch(() => {
        // Heartbeat failures are non-fatal — API may be temporarily unreachable
    });
}, HEARTBEAT_INTERVAL_MS);
// Inbox polling — notify the agent when new tasks or messages arrive
const POLL_INTERVAL_MS = 15_000;
const seenTaskIds = new Set();
const seenMessageIds = new Set();
async function pollInbox() {
    try {
        const [tasks, messages] = await Promise.all([
            apiClient.getTasks({ projectId: PROJECT_ID, assignedTo: AGENT_ID, status: "assigned" }),
            apiClient.getUnread(AGENT_ID, PROJECT_ID),
        ]);
        const newTasks = tasks.filter((t) => !seenTaskIds.has(t.id));
        const newMessages = messages.filter((m) => !seenMessageIds.has(m.id));
        for (const task of newTasks) {
            seenTaskIds.add(task.id);
            await server.server.sendLoggingMessage({
                level: "info",
                data: `📋 New task assigned: "${task.title}" [${task.id}] — call get_my_tasks to begin`,
            });
        }
        for (const msg of newMessages) {
            seenMessageIds.add(msg.id);
            await server.server.sendLoggingMessage({
                level: "info",
                data: `💬 New ${msg.type} message from ${msg.fromAgent} in thread ${msg.threadId} — call get_unread_messages to read`,
            });
        }
    }
    catch {
        // Non-fatal — API may be temporarily unreachable
    }
}
// Seed seen sets on startup so we only notify about truly new items
apiClient.getTasks({ projectId: PROJECT_ID, assignedTo: AGENT_ID, status: "assigned" })
    .then((tasks) => tasks.forEach((t) => seenTaskIds.add(t.id)))
    .catch(() => { });
apiClient.getUnread(AGENT_ID, PROJECT_ID)
    .then((msgs) => msgs.forEach((m) => seenMessageIds.add(m.id)))
    .catch(() => { });
setInterval(pollInbox, POLL_INTERVAL_MS);
// Transport
async function main() {
    if (TRANSPORT === "stdio") {
        const transport = new stdio_js_1.StdioServerTransport();
        await server.connect(transport);
    }
    else if (TRANSPORT === "http") {
        // HTTP/SSE transport — for remote/team scenarios
        // Import lazily so stdio-only installs don't need the HTTP deps
        const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
        const http = await import("node:http");
        const port = Number(process.env.MCP_PORT ?? 3001);
        const httpServer = http.createServer(async (req, res) => {
            if (req.method === "GET" && req.url === "/sse") {
                const transport = new SSEServerTransport("/messages", res);
                await server.connect(transport);
            }
            else if (req.method === "POST" && req.url === "/messages") {
                res.writeHead(200).end();
            }
            else {
                res.writeHead(404).end();
            }
        });
        httpServer.listen(port, () => {
            console.error(`[orch-mcp] HTTP/SSE transport listening on port ${port}`);
        });
    }
    else {
        console.error(`[orch-mcp] Unknown TRANSPORT: ${TRANSPORT}. Use 'stdio' or 'http'.`);
        process.exit(1);
    }
}
main().catch((err) => { console.error(err); process.exit(1); });
//# sourceMappingURL=index.js.map