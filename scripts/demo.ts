#!/usr/bin/env tsx
/**
 * Live demo setup — creates a fresh project, registers agents, queues real tasks.
 *
 * Requires:
 *   - API running:  pnpm --filter @ai-orchestrator/api dev
 *   - MCP built:   pnpm --filter @ai-orchestrator/mcp-server build
 *
 * Usage:
 *   API_SECRET=changeme pnpm demo
 */

const API_URL = process.env.ORCHESTRATOR_API_URL ?? "http://localhost:3010";
const SECRET  = process.env.API_SECRET ?? process.env.ORCHESTRATOR_API_SECRET ?? "changeme";

// ── API helpers ────────────────────────────────────────────────────────────

const headers = { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method, headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json() as { data?: T; error?: { message: string } };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error?.message}`);
  return json.data as T;
}

// ── Output helpers ─────────────────────────────────────────────────────────

const c = {
  reset:  "\x1b[0m",  dim:    "\x1b[2m",  bold:   "\x1b[1m",
  green:  "\x1b[32m", yellow: "\x1b[33m", cyan:   "\x1b[36m",
  red:    "\x1b[31m", blue:   "\x1b[34m",
};

function ok(msg: string)     { console.log(`${c.green}✓${c.reset}  ${msg}`); }
function info(msg: string)   { console.log(`${c.cyan}→${c.reset}  ${msg}`); }
function header(msg: string) { console.log(`\n${c.bold}${c.blue}${msg}${c.reset}\n${"─".repeat(50)}`); }
function waitForEnter() {
  return new Promise<void>((resolve) => {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      resolve();
    });
  });
}

// ── Demo ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${c.bold}AI Orchestrator — Live Demo Setup${c.reset}\n`);

  // Health check
  try {
    await api("GET", "/health");
  } catch {
    console.error(`${c.red}API not reachable at ${API_URL}${c.reset}`);
    console.error("Start it first:  pnpm --filter @ai-orchestrator/api dev");
    process.exit(1);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  header("Setup");

  const existing = await api<{ id: string; name: string }[]>("GET", "/projects");
  const old = existing.filter((p) => p.name === "demo-project");
  if (old.length > 0) {
    info(`Removing ${old.length} previous demo project(s)...`);
    for (const p of old) await api("DELETE", `/projects/${p.id}`);
  }

  const project = await api<{ id: string; name: string }>("POST", "/projects", {
    name: "demo-project",
    description: "Live AI Orchestrator demo",
  });
  ok(`Project: ${c.bold}${project.name}${c.reset}  ${c.dim}${project.id}${c.reset}`);

  // Register agents
  type Agent = { id: string; name: string };

  const copilot = await api<Agent>("POST", "/agents", {
    projectId: project.id, name: "copilot",
    role: "worker", specialization: "reviewer", tier: 1,
    domains: ["review", "docs", "tickets", "pr", "code-quality"],
  });
  await api("PUT", `/agents/${copilot.id}/heartbeat`, {});
  ok(`Copilot  ${c.dim}tier-1 · reviewer${c.reset}   ${c.dim}${copilot.id}${c.reset}`);

  const claude = await api<Agent>("POST", "/agents", {
    projectId: project.id, name: "claude",
    role: "worker", specialization: "architect", tier: 2,
    domains: ["architecture", "design", "implementation", "planning"],
  });
  await api("PUT", `/agents/${claude.id}/heartbeat`, {});
  ok(`Claude   ${c.dim}tier-2 · architect${c.reset}  ${c.dim}${claude.id}${c.reset}`);

  // ── UI reconnect ──────────────────────────────────────────────────────────
  console.log(`\n  ${c.bold}Connect the web UI to this project:${c.reset}`);
  console.log(`  If already connected, click ${c.bold}Disconnect${c.reset} first, then reconnect.`);
  console.log(`\n  ${c.dim}API URL:${c.reset}    http://localhost:3010`);
  console.log(`  ${c.dim}Secret:${c.reset}     ${SECRET}`);
  console.log(`  ${c.dim}Project:${c.reset}    ${c.bold}${c.cyan}demo-project${c.reset}  ${c.dim}(ends ...${project.id.slice(-8)})${c.reset}`);
  console.log(`\n  Go to ${c.bold}Threads${c.reset}, then press Enter to queue the demo tasks.`);
  await waitForEnter();
  console.log();

  // ── Queue real tasks ──────────────────────────────────────────────────────
  header("Queuing tasks");

  // Task 1: code review (→ Copilot tier-1)
  const thread1 = await api<{ id: string }>("POST", "/threads", {
    projectId: project.id,
    title: "Review: api/src/lib/routing.ts",
  });

  const task1 = await api<{ id: string; status: string; assignedTo: string }>("POST", "/tasks", {
    projectId: project.id,
    createdBy: claude.id,
    title: "Review routing.ts for correctness",
    description: [
      "Review packages/api/src/lib/routing.ts",
      "",
      "Focus on:",
      "- Is the 10-minute online window the right threshold?",
      "- Does the load-balancing tiebreaker handle the single-agent case correctly?",
      "- Any edge cases in the in-progress task count query?",
      "- Style and readability.",
    ].join("\n"),
    domains: ["review", "code-quality", "typescript"],
    metadata: { sourceThread: thread1.id },
  });
  ok(`Task 1: ${c.bold}"${task1.status}"${c.reset} → ${task1.assignedTo === copilot.id ? "Copilot ✓" : task1.assignedTo}`);

  // Task 2: document the routing module (→ Copilot tier-1)
  const thread2 = await api<{ id: string }>("POST", "/threads", {
    projectId: project.id,
    title: "Docs: routing module",
  });

  const task2 = await api<{ id: string; status: string; assignedTo: string }>("POST", "/tasks", {
    projectId: project.id,
    createdBy: claude.id,
    title: "Write docs for the routing module",
    description: [
      "Write clear inline documentation for packages/api/src/lib/routing.ts",
      "",
      "Include:",
      "- A module-level comment explaining the purpose",
      "- JSDoc for the pickAgent function (params, return, behaviour when no agents online)",
      "- Note the 10-minute online threshold",
    ].join("\n"),
    domains: ["docs", "typescript"],
    metadata: { sourceThread: thread2.id },
  });
  ok(`Task 2: ${c.bold}"${task2.status}"${c.reset} → ${task2.assignedTo === copilot.id ? "Copilot ✓" : task2.assignedTo}`);

  // ── Copilot worker instructions ───────────────────────────────────────────
  header("Start the Copilot worker");

  console.log(`  Run this in a new terminal:\n`);
  console.log(`  ${c.dim}GITHUB_TOKEN=<your-token> \\${c.reset}`);
  console.log(`  ${c.dim}AGENT_ID=${copilot.id} \\${c.reset}`);
  console.log(`  ${c.dim}PROJECT_ID=${project.id} \\${c.reset}`);
  console.log(`  ${c.dim}ORCHESTRATOR_API_SECRET=${SECRET} \\${c.reset}`);
  console.log(`  ${c.dim}REPO_PATH=$(pwd) \\${c.reset}`);
  console.log(`  ${c.cyan}pnpm --filter @ai-orchestrator/copilot-worker dev${c.reset}`);

  console.log(`\n  Register Claude Code as tier-2 (run in your Claude Code session):`);
  console.log(`  ${c.dim}AGENT_ID=${claude.id}   PROJECT_ID=${project.id}${c.reset}`);

  console.log(`\n  Watch Threads in the UI — Copilot will pick up both tasks within 15s.\n`);
}

main().catch((err) => {
  console.error(`\n${c.red}Demo failed:${c.reset}`, err.message);
  process.exit(1);
});
