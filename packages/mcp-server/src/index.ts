#!/usr/bin/env node
// ai-orchestrator MCP server
// Supports two transports:
//   stdio (default) — Claude Code, Copilot in VS Code, any local MCP client
//   http            — remote/team scenarios; set TRANSPORT=http

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "./api-client.js";
import { buildTools } from "./tools.js";

const {
  ORCHESTRATOR_API_URL = "http://localhost:3010",
  ORCHESTRATOR_API_SECRET,
  AGENT_ID,
  PROJECT_ID,
  TRANSPORT = "stdio",
} = process.env;

if (!ORCHESTRATOR_API_SECRET) {
  console.error("[orch-mcp] ORCHESTRATOR_API_SECRET is required");
  process.exit(1);
}
if (!AGENT_ID) {
  console.error("[orch-mcp] AGENT_ID is required — register your agent first and pass its ID here");
  process.exit(1);
}
if (!PROJECT_ID) {
  console.error("[orch-mcp] PROJECT_ID is required");
  process.exit(1);
}

const apiClient = new ApiClient({
  baseUrl: ORCHESTRATOR_API_URL,
  secret: ORCHESTRATOR_API_SECRET,
});

const server = new McpServer({
  name: "ai-orchestrator",
  version: "0.1.0",
});

// Register all tools
const tools = buildTools(apiClient, AGENT_ID, PROJECT_ID);

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
const seenTaskIds = new Set<string>();
const seenMessageIds = new Set<string>();

async function pollInbox() {
  try {
    const [tasks, messages] = await Promise.all([
      apiClient.getTasks({ projectId: PROJECT_ID!, assignedTo: AGENT_ID!, status: "assigned" }),
      apiClient.getUnread(AGENT_ID!, PROJECT_ID!),
    ]);

    const newTasks = tasks.filter((t: any) => !seenTaskIds.has(t.id));
    const newMessages = messages.filter((m: any) => !seenMessageIds.has(m.id));

    for (const task of newTasks) {
      seenTaskIds.add((task as any).id);
      await server.server.sendLoggingMessage({
        level: "info",
        data: `📋 New task assigned: "${(task as any).title}" [${(task as any).id}] — call get_my_tasks to begin`,
      });
    }

    for (const msg of newMessages) {
      seenMessageIds.add((msg as any).id);
      await server.server.sendLoggingMessage({
        level: "info",
        data: `💬 New ${(msg as any).type} message from ${(msg as any).fromAgent} in thread ${(msg as any).threadId} — call get_unread_messages to read`,
      });
    }
  } catch {
    // Non-fatal — API may be temporarily unreachable
  }
}

// Seed seen sets on startup so we only notify about truly new items
apiClient.getTasks({ projectId: PROJECT_ID!, assignedTo: AGENT_ID!, status: "assigned" })
  .then((tasks: any[]) => tasks.forEach((t: any) => seenTaskIds.add(t.id)))
  .catch(() => {});
apiClient.getUnread(AGENT_ID!, PROJECT_ID!)
  .then((msgs: any[]) => msgs.forEach((m: any) => seenMessageIds.add(m.id)))
  .catch(() => {});

setInterval(pollInbox, POLL_INTERVAL_MS);

// Transport
async function main() {
  if (TRANSPORT === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else if (TRANSPORT === "http") {
    // HTTP/SSE transport — for remote/team scenarios
    // Import lazily so stdio-only installs don't need the HTTP deps
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
    const http = await import("node:http");

    const port = Number(process.env.MCP_PORT ?? 3001);

    const httpServer = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        await server.connect(transport);
      } else if (req.method === "POST" && req.url === "/messages") {
        res.writeHead(200).end();
      } else {
        res.writeHead(404).end();
      }
    });

    httpServer.listen(port, () => {
      console.error(`[orch-mcp] HTTP/SSE transport listening on port ${port}`);
    });
  } else {
    console.error(`[orch-mcp] Unknown TRANSPORT: ${TRANSPORT}. Use 'stdio' or 'http'.`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
