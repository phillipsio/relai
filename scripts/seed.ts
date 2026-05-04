#!/usr/bin/env tsx
/**
 * Bootstraps a fresh database with one project and one agent,
 * then prints the IDs and patches .env with AGENT_ID and PROJECT_ID.
 *
 * Usage:
 *   API_SECRET=changeme tsx scripts/seed.ts [project-name] [agent-name] [preset]
 *
 * Presets:
 *   claude    (default) — tier-2 implementer; writes code, handles escalations
 *   copilot              — tier-1 worker; review, docs, tickets, PRs
 *   architect / writer / reviewer / tester / devops — specialization aliases
 *
 * Requires the API server to be running (pnpm --filter @getrelai/api dev).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_PRESETS } from "./presets.js";

const API_URL  = process.env.ORCHESTRATOR_API_URL  ?? "http://localhost:3010";
const SECRET   = process.env.API_SECRET             ?? process.env.ORCHESTRATOR_API_SECRET ?? "";
const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

async function post(endpoint: string, body: unknown) {
  const res = await fetch(`${API_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SECRET}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${endpoint} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ data: Record<string, unknown> }>;
}

function patchEnv(projectId: string, agentId: string) {
  if (!fs.existsSync(ENV_PATH)) {
    console.log(`  (no .env at ${ENV_PATH} — skipping patch)`);
    return;
  }
  let src = fs.readFileSync(ENV_PATH, "utf8");
  src = src.replace(/^AGENT_ID=.*$/m,   `AGENT_ID=${agentId}`);
  src = src.replace(/^PROJECT_ID=.*$/m, `PROJECT_ID=${projectId}`);
  fs.writeFileSync(ENV_PATH, src);
  console.log(`  .env patched`);
}

async function main() {
  if (!SECRET) {
    console.error("Error: API_SECRET (or ORCHESTRATOR_API_SECRET) must be set.");
    process.exit(1);
  }

  const projectName = process.argv[2] ?? "my-project";
  const agentName   = process.argv[3] ?? "claude";
  const presetKey   = process.argv[4] ?? "claude";

  const preset = ROLE_PRESETS[presetKey];
  if (!preset) {
    console.error(`Unknown role preset: "${presetKey}". Valid options: ${Object.keys(ROLE_PRESETS).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nSeeding against ${API_URL}…\n`);

  const { data: project } = await post("/projects", {
    name: projectName,
    description: "Created by seed script",
  });
  console.log(`✓ Project:        ${project.id}  (${project.name})`);

  const { data: agent } = await post("/agents", {
    projectId:      project.id,
    name:           agentName,
    role:           preset.role,
    specialization: preset.specialization,
    tier:           preset.tier,
    domains:        preset.domains,
  });
  console.log(`✓ Agent:          ${agent.id}  (${agent.name})`);
  console.log(`  specialization: ${agent.specialization}`);
  console.log(`  domains:        ${(agent.domains as string[]).join(", ") || "(none)"}`);

  patchEnv(project.id as string, agent.id as string);

  console.log(`
Done. Add these to your MCP server config:
  AGENT_ID=${agent.id}
  PROJECT_ID=${project.id}

To add more agents to this project:
  API_SECRET=... tsx scripts/add-agent.ts ${project.id} <name> <preset>
  Presets: ${Object.keys(ROLE_PRESETS).join(", ")}
`);
}

main().catch((err) => { console.error(err); process.exit(1); });
