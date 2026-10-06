#!/usr/bin/env node
// ai-orchestrator MCP server
// Supports two transports:
//   stdio (default) — Claude Code, Copilot in VS Code, any local MCP client
//   http            — remote/team scenarios; set TRANSPORT=http

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMcpServer } from "./create-server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "./api-client.js";
import type { ToolConfig } from "./tools.js";
import { registerTools } from "./register-tools.js";
import { diffAttention, type AttentionState, type WatchTask } from "./owner-watch.js";
import { assertRepoMatch } from "./repo-guard.js";

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
// triage and unblocking. Otherwise the default per-agent mode exposes the agent
// tools scoped to one project.
const OWNER_MODE = Boolean(API_OWNER_TOKEN);

if (OWNER_MODE) {
  if (!OWNER_ID || !OWNER_ID.startsWith("usr_")) {
    console.error("[relai-mcp] owner mode requires OWNER_ID (a 'usr_…' id) alongside API_OWNER_TOKEN");
    process.exit(1);
  }
  // API_OWNER_TOKEN is a cross-project credential — with a different X-Owner-Id
  // it can act as any owner. The HTTP transport below requires this same
  // credential as a bearer token, but still bind to localhost behind an
  // authenticating proxy for defense in depth. See docs/operator-ingress.md.
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

const server = createMcpServer(OWNER_MODE ? "relai-operator" : "relai", pkg.version);

// Register tools for the active mode. In agent mode the CREDENTIAL decides
// whether the provisioning verbs appear, not the environment: tokens.ownerId
// exists so possession determines authority, and choosing the toolset from an
// env var left that true at the API and false at the layer the model uses.
// Awaited before connect, bounded, and fails closed — see owner-scope.ts.
const toolConfig: ToolConfig = OWNER_MODE
  ? { ownerMode: true, ownerId: OWNER_ID }
  : { ownerMode: false, agentId: AGENT_ID!, repoId: REPO_ID! };

// No agent identity here, so heartbeat does not apply but attention does:
// without this the console saw only what the operator thought to ask for.
if (OWNER_MODE) {
  const OWNER_POLL_INTERVAL_MS = Number(process.env.OWNER_POLL_INTERVAL_MS ?? 60_000);
  let seen: Map<string, AttentionState> | null = null;

  async function pollAttention() {
    try {
      // Two calls because stalled work is still `in_progress`: its status looks
      // healthy and only `stalledAt` gives it away.
      const [attention, active] = await Promise.all([
        apiClient.getTasks({ status: "blocked,pending_verification,proposed" }),
        apiClient.getTasks({ status: "in_progress" }),
      ]);
      const { notices, next } = diffAttention(seen, [...attention, ...active] as WatchTask[]);
      seen = next;
      for (const data of notices) {
        await server.server.sendLoggingMessage({ level: "warning", data });
      }
    } catch (err) {
      // Logged, not swallowed: a silent catch here is what hid the missing
      // logging capability. `seen` is left as-is so a blip does not replay the
      // backlog as new transitions.
      console.error("[relai-mcp] attention poll failed:", err instanceof Error ? err.message : err);
    }
  }

  void pollAttention();
  setInterval(pollAttention, OWNER_POLL_INTERVAL_MS);
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
      apiClient.getUnread(AGENT_ID!, REPO_ID!).then((r) => r.data ?? []),
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
  } catch (err) {
    console.error("[relai-mcp] inbox poll failed:", err instanceof Error ? err.message : err);
  }
}

// Seed seen sets on startup so we only notify about truly new items
apiClient.getTasks({ repoId: REPO_ID!, assignedTo: AGENT_ID!, status: "assigned" })
  .then((tasks: any[]) => tasks.forEach((t: any) => seenTaskIds.add(t.id)))
  .catch(() => {});
apiClient.getUnread(AGENT_ID!, REPO_ID!)
  .then((r) => (r.data ?? []).forEach((m: any) => seenMessageIds.add(m.id)))
  .catch(() => {});

setInterval(pollInbox, POLL_INTERVAL_MS);
}

// Repo guard: in agent mode, refuse to serve unless a clone of the agent's repo
// can be located (no-ops when the repo has no url or under
// RELAI_SKIP_REPO_CHECK). Owner mode is exempt — it acts across all repos and
// has no single working tree. A null url / unreachable API just skips the check.
// See repo-guard.ts for which directories are considered, in what order, and why.
async function assertRepoOrExit() {
  if (OWNER_MODE) return;
  let repoUrl: string | null = null;
  try {
    repoUrl = (await apiClient.getRepo(REPO_ID!))?.repoUrl ?? null;
  } catch {
    return; // can't resolve the repo (e.g. API unreachable) — don't hard-block
  }
  if (!repoUrl || process.env.RELAI_SKIP_REPO_CHECK) return;

  const result = await assertRepoMatch(
    process.cwd(),
    repoUrl,
    async () => (await apiClient.getAgent(AGENT_ID!))?.repoPath,
  );
  if (result.ok) {
    if (result.via) console.error(`[relai-mcp] repo guard passed via ${result.via}`);
    return;
  }
  console.error(result.message);
  process.exit(1);
}

// Transport
async function main() {
  await assertRepoOrExit();
  // Before connect: a client that connects first would see whatever was
  // registered at that instant.
  await registerTools(server, apiClient, toolConfig);
  if (TRANSPORT === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else if (TRANSPORT === "http") {
    // HTTP/SSE transport — for remote/team scenarios. Gated on the same
    // credential this process already holds (API_SECRET or API_OWNER_TOKEN) —
    // see http-transport.ts. Still bind to loopback by default and put an
    // authenticating layer (tunnel/proxy/VPN) in front for remote access
    // rather than binding to all interfaces. Override only deliberately via
    // MCP_HOST.
    const http = await import("node:http");
    const { createHttpRequestListener } = await import("./http-transport.js");

    const port = Number(process.env.MCP_PORT ?? 3001);
    const host = process.env.MCP_HOST ?? "127.0.0.1";
    // MCP_HTTP_TOKEN lets the transport gate use a credential distinct from
    // the one forwarded to the API — so a leaked transport token doesn't
    // itself grant upstream API access. Falls back to the process credential
    // when unset, preserving the simpler single-credential setup.
    const credential = process.env.MCP_HTTP_TOKEN || (OWNER_MODE ? API_OWNER_TOKEN! : API_SECRET!);

    const listener = createHttpRequestListener(server, credential);
    const httpServer = http.createServer(listener);

    httpServer.listen(port, host, () => {
      console.error(`[relai-mcp] HTTP/SSE transport listening on ${host}:${port}`);
    });
  } else {
    console.error(`[relai-mcp] Unknown TRANSPORT: ${TRANSPORT}. Use 'stdio' or 'http'.`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
