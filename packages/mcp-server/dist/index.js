#!/usr/bin/env node
"use strict";
// ai-orchestrator MCP server
// Supports two transports:
//   stdio (default) — Claude Code, Copilot in VS Code, any local MCP client
//   http            — remote/team scenarios; set TRANSPORT=http
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const api_client_js_1 = require("./api-client.js");
const tools_js_1 = require("./tools.js");
const git_1 = require("@getrelai/git");
// Report the package version (dist/index.js → ../package.json) so the MCP
// handshake matches the published package.
const pkg = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, "../package.json"), "utf8"));
const { API_URL = "http://localhost:3010", API_SECRET, AGENT_ID, REPO_ID, API_OWNER_TOKEN, OWNER_ID, TRANSPORT = "stdio", } = process.env;
// Two modes. Owner mode (API_OWNER_TOKEN + OWNER_ID) exposes the operator
// toolset that acts across ALL of the owner's projects — for remote/mobile
// triage and unblocking. Otherwise the default per-agent mode exposes the 13
// agent tools scoped to one project.
const OWNER_MODE = Boolean(API_OWNER_TOKEN);
if (OWNER_MODE) {
    if (!OWNER_ID || !OWNER_ID.startsWith("usr_")) {
        console.error("[relai-mcp] owner mode requires OWNER_ID (a 'usr_…' id) alongside API_OWNER_TOKEN");
        process.exit(1);
    }
    // API_OWNER_TOKEN is a cross-project credential — with a different X-Owner-Id
    // it can act as any owner. The HTTP transport below is unauthenticated, so
    // this process must sit behind an authenticating proxy / bound to localhost,
    // never exposed directly. See docs/operator-ingress.md.
    console.error("[relai-mcp] owner mode: API_OWNER_TOKEN is a god-key credential — keep this server " +
        "off the open internet (localhost bind + authenticating reverse proxy only).");
}
else {
    if (!API_SECRET) {
        console.error("[relai-mcp] API_SECRET is required");
        process.exit(1);
    }
    if (!AGENT_ID) {
        console.error("[relai-mcp] AGENT_ID is required — register your agent first and pass its ID here");
        process.exit(1);
    }
    if (!REPO_ID) {
        console.error("[relai-mcp] REPO_ID is required");
        process.exit(1);
    }
}
const apiClient = new api_client_js_1.ApiClient({
    baseUrl: API_URL,
    secret: OWNER_MODE ? API_OWNER_TOKEN : API_SECRET,
    ownerId: OWNER_MODE ? OWNER_ID : undefined,
});
const server = new mcp_js_1.McpServer({
    name: OWNER_MODE ? "relai-operator" : "relai",
    version: pkg.version,
});
// Register tools for the active mode.
const tools = OWNER_MODE
    ? (0, tools_js_1.buildOperatorTools)(apiClient)
    : (0, tools_js_1.buildTools)(apiClient, AGENT_ID, REPO_ID);
for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.inputSchema.shape, tool.handler);
}
// Heartbeat + inbox polling are per-agent concerns — skipped in owner mode,
// which has no single agent identity or project to poll.
if (!OWNER_MODE) {
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
                apiClient.getTasks({ repoId: REPO_ID, assignedTo: AGENT_ID, status: "assigned" }),
                apiClient.getUnread(AGENT_ID, REPO_ID),
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
    apiClient.getTasks({ repoId: REPO_ID, assignedTo: AGENT_ID, status: "assigned" })
        .then((tasks) => tasks.forEach((t) => seenTaskIds.add(t.id)))
        .catch(() => { });
    apiClient.getUnread(AGENT_ID, REPO_ID)
        .then((msgs) => msgs.forEach((m) => seenMessageIds.add(m.id)))
        .catch(() => { });
    setInterval(pollInbox, POLL_INTERVAL_MS);
}
// Repo guard: in agent mode, refuse to serve if this process isn't running in a
// clone of the agent's repo (no-ops when the repo has no url or under
// RELAI_SKIP_REPO_CHECK). Owner mode is exempt — it acts across all repos and
// has no single working tree. A null url / unreachable API just skips the check.
async function assertRepoOrExit() {
    if (OWNER_MODE)
        return;
    let repoUrl = null;
    try {
        repoUrl = (await apiClient.getRepo(REPO_ID))?.repoUrl ?? null;
    }
    catch {
        return; // can't resolve the repo (e.g. API unreachable) — don't hard-block
    }
    const check = (0, git_1.checkRepoMatch)(process.cwd(), repoUrl);
    if (!check.ok) {
        console.error(`[relai-mcp] ${check.reason}\n  ${check.fix}`);
        process.exit(1);
    }
}
// Transport
async function main() {
    await assertRepoOrExit();
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
        // The HTTP/SSE transport is unauthenticated and, in owner mode, carries a
        // god-key credential — so bind to loopback by default. Put an
        // authenticating layer (tunnel/proxy/VPN) in front for remote access rather
        // than binding to all interfaces. Override only deliberately via MCP_HOST.
        const host = process.env.MCP_HOST ?? "127.0.0.1";
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
        httpServer.listen(port, host, () => {
            console.error(`[relai-mcp] HTTP/SSE transport listening on ${host}:${port}`);
        });
    }
    else {
        console.error(`[relai-mcp] Unknown TRANSPORT: ${TRANSPORT}. Use 'stdio' or 'http'.`);
        process.exit(1);
    }
}
main().catch((err) => { console.error(err); process.exit(1); });
//# sourceMappingURL=index.js.map