#!/usr/bin/env node
// ai-orchestrator MCP server
// Supports two transports:
//   stdio (default) — Claude Code, Copilot in VS Code, any local MCP client
//   http            — remote/team scenarios; set TRANSPORT=http

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "./api-client.js";
import { buildTools, buildOperatorTools } from "./tools.js";

// Report the package version (dist/index.js → ../package.json) so the MCP
// handshake matches the published package.
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf8"),
) as { version: string };

const {
  API_URL = "http://localhost:3010",
  API_SECRET,
  AGENT_ID,
  REPO_ID,
  API_OWNER_TOKEN,
  OWNER_ID,
  TRANSPORT = "stdio",
} = process.env;

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
  console.error(
    "[relai-mcp] owner mode: API_OWNER_TOKEN is a god-key credential — keep this server " +
    "off the open internet (localhost bind + authenticating reverse proxy only).",
  );
} else {
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

const apiClient = new ApiClient({
  baseUrl: API_URL,
  secret: OWNER_MODE ? API_OWNER_TOKEN! : API_SECRET!,
  ownerId: OWNER_MODE ? OWNER_ID : undefined,
});

const server = new McpServer({
  name: OWNER_MODE ? "relai-operator" : "relai",
  version: pkg.version,
});

// Register tools for the active mode.
const tools = OWNER_MODE
  ? buildOperatorTools(apiClient)
  : buildTools(apiClient, AGENT_ID!, REPO_ID!);

for (const tool of tools) {
  server.tool(tool.name, tool.description, tool.inputSchema.shape, tool.handler);
}

// Heartbeat + inbox polling are per-agent concerns — skipped in owner mode,
// which has no single agent identity or project to poll.
if (!OWNER_MODE) {
// Start heartbeat — keeps agent "online" in the project without Claude calls
const HEARTBEAT_INTERVAL_MS = 60_000;
setInterval(() => {
  apiClient.heartbeat(AGENT_ID!).catch(() => {
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
      apiClient.getTasks({ repoId: REPO_ID!, assignedTo: AGENT_ID!, status: "assigned" }),
      apiClient.getUnread(AGENT_ID!, REPO_ID!),
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
apiClient.getTasks({ repoId: REPO_ID!, assignedTo: AGENT_ID!, status: "assigned" })
  .then((tasks: any[]) => tasks.forEach((t: any) => seenTaskIds.add(t.id)))
  .catch(() => {});
apiClient.getUnread(AGENT_ID!, REPO_ID!)
  .then((msgs: any[]) => msgs.forEach((m: any) => seenMessageIds.add(m.id)))
  .catch(() => {});

setInterval(pollInbox, POLL_INTERVAL_MS);
}

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
    // The HTTP/SSE transport is unauthenticated and, in owner mode, carries a
    // god-key credential — so bind to loopback by default. Put an
    // authenticating layer (tunnel/proxy/VPN) in front for remote access rather
    // than binding to all interfaces. Override only deliberately via MCP_HOST.
    const host = process.env.MCP_HOST ?? "127.0.0.1";

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

    httpServer.listen(port, host, () => {
      console.error(`[relai-mcp] HTTP/SSE transport listening on ${host}:${port}`);
    });
  } else {
    console.error(`[relai-mcp] Unknown TRANSPORT: ${TRANSPORT}. Use 'stdio' or 'http'.`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
