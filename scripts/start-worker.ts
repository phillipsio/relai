#!/usr/bin/env tsx
/**
 * Registers a claude-worker agent and starts it in one step.
 *
 * Usage:
 *   API_SECRET=changeme tsx scripts/start-worker.ts <specialization> [options]
 *
 * Options:
 *   --name <name>     Agent name (default: <specialization>-worker)
 *   --repo <path>     Repo path for the worker (default: $REPO_PATH or cwd)
 *   --model <id>      Claude model (default: claude-sonnet-4-6)
 *
 * Examples:
 *   API_SECRET=changeme tsx scripts/start-worker.ts writer
 *   API_SECRET=changeme tsx scripts/start-worker.ts reviewer --model claude-haiku-4-5-20251001
 *   API_SECRET=changeme tsx scripts/start-worker.ts architect --repo /path/to/repo --name jim-architect
 *
 * Requires API to be running and PROJECT_ID set in .env (run seed.ts first).
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { ROLE_PRESETS } from "./presets.js";

// --- Config -----------------------------------------------------------------

const API_URL    = process.env.ORCHESTRATOR_API_URL ?? "http://localhost:3010";
const API_SECRET = process.env.API_SECRET ?? process.env.ORCHESTRATOR_API_SECRET ?? "";
const PROJECT_ID = process.env.PROJECT_ID ?? "";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_ENTRY = path.join(ROOT, "packages", "claude-worker", "src", "index.ts");
const TSX_BIN = path.join(ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx");

// --- Args -------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const specialization = args[0];
  const opts: { name?: string; repo?: string; model?: string } = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--name"  && args[i + 1]) { opts.name  = args[++i]; continue; }
    if (args[i] === "--repo"  && args[i + 1]) { opts.repo  = args[++i]; continue; }
    if (args[i] === "--model" && args[i + 1]) { opts.model = args[++i]; continue; }
  }

  return { specialization, opts };
}

// --- API helpers ------------------------------------------------------------

async function post(endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_SECRET}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${endpoint} → ${res.status}: ${text}`);
  }
  const json = await res.json() as { data: Record<string, unknown> };
  return json.data;
}

async function findExistingAgent(name: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${API_URL}/agents?projectId=${PROJECT_ID}`, {
    headers: { Authorization: `Bearer ${API_SECRET}` },
  });
  if (!res.ok) return null;
  const json = await res.json() as { data: Record<string, unknown>[] };
  return json.data.find((a) => a.name === name) ?? null;
}

async function checkApi(): Promise<void> {
  const res = await fetch(`${API_URL}/health`, {
    headers: { Authorization: `Bearer ${API_SECRET}` },
  }).catch(() => null);
  if (!res?.ok) {
    throw new Error(`API at ${API_URL} is not reachable. Is it running?`);
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  const { specialization, opts } = parseArgs();

  if (!specialization) {
    const valid = Object.keys(ROLE_PRESETS).join(", ");
    console.error(`Usage: tsx scripts/start-worker.ts <specialization> [--name <name>] [--repo <path>] [--model <id>]`);
    console.error(`Valid specializations: ${valid}`);
    process.exit(1);
  }

  if (!API_SECRET) {
    console.error("Error: API_SECRET (or ORCHESTRATOR_API_SECRET) must be set.");
    process.exit(1);
  }

  if (!PROJECT_ID) {
    console.error("Error: PROJECT_ID must be set in .env (run seed.ts first).");
    process.exit(1);
  }

  const preset = ROLE_PRESETS[specialization];
  if (!preset) {
    const valid = Object.keys(ROLE_PRESETS).join(", ");
    console.error(`Unknown specialization "${specialization}". Valid: ${valid}`);
    process.exit(1);
  }

  const name  = opts.name  ?? `${specialization}-worker`;
  const repo  = opts.repo  ?? process.env.REPO_PATH ?? process.cwd();
  const model = opts.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";

  // Verify API is reachable before registering
  console.log(`\nConnecting to API at ${API_URL}…`);
  await checkApi();

  const existing = await findExistingAgent(name);
  let agent: Record<string, unknown>;

  if (existing) {
    agent = existing;
    console.log(`✓ Agent found:      ${agent.id}  (reusing "${name}")`);
  } else {
    console.log(`Registering agent "${name}" (${specialization})…`);
    agent = await post("/agents", {
      projectId:      PROJECT_ID,
      name,
      role:           preset.role,
      specialization: preset.specialization,
      domains:        preset.domains,
    });
    console.log(`✓ Agent registered: ${agent.id}`);
  }

  const agentId = agent.id as string;
  console.log(`  specialization: ${agent.specialization}`);
  console.log(`  domains:        ${(agent.domains as string[]).join(", ") || "(none)"}`);
  console.log(`  repo:           ${repo}`);
  console.log(`  model:          ${model}`);
  console.log(`\nStarting worker…\n`);

  const workerEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    AGENT_ID:                  agentId,
    PROJECT_ID,
    ORCHESTRATOR_API_URL:      API_URL,
    ORCHESTRATOR_API_SECRET:   API_SECRET,
    SPECIALIZATION:             specialization,
    REPO_PATH:                  repo,
    CLAUDE_MODEL:               model,
  };

  const proc = spawn(
    TSX_BIN,
    [WORKER_ENTRY],
    { env: workerEnv, stdio: "inherit" },
  );

  // Forward termination signals so the worker can clean up
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      proc.kill(sig);
    });
  }

  proc.on("exit", (code, signal) => {
    if (signal) {
      console.log(`\n[start-worker] Worker exited (${signal})`);
      process.exit(0);
    }
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error("[start-worker]", err.message);
  process.exit(1);
});
