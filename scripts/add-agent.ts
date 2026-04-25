#!/usr/bin/env tsx
/**
 * Adds an agent to an existing project.
 *
 * Usage:
 *   API_SECRET=changeme tsx scripts/add-agent.ts <project-id> <name> [preset]
 *
 * Presets: orchestrator, architect, writer, reviewer, tester, devops
 *
 * Requires the API server to be running.
 */

import { ROLE_PRESETS } from "./presets.js";

const API_URL = process.env.ORCHESTRATOR_API_URL ?? "http://localhost:3010";
const SECRET  = process.env.API_SECRET ?? process.env.ORCHESTRATOR_API_SECRET ?? "";

async function post(endpoint: string, body: unknown) {
  const res = await fetch(`${API_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`POST ${endpoint} → ${res.status}: ${t}`); }
  return res.json() as Promise<{ data: Record<string, unknown> }>;
}

async function main() {
  if (!SECRET) { console.error("Error: API_SECRET must be set."); process.exit(1); }

  const projectId = process.argv[2];
  const name      = process.argv[3];
  const presetKey = process.argv[4] ?? "writer";

  if (!projectId || !name) {
    console.error("Usage: tsx scripts/add-agent.ts <project-id> <name> [preset]");
    console.error(`Presets: ${Object.keys(ROLE_PRESETS).join(", ")}`);
    process.exit(1);
  }

  const preset = ROLE_PRESETS[presetKey];
  if (!preset) {
    console.error(`Unknown preset: "${presetKey}". Valid: ${Object.keys(ROLE_PRESETS).join(", ")}`);
    process.exit(1);
  }

  const { data: agent } = await post("/agents", {
    projectId, name,
    role:           preset.role,
    specialization: preset.specialization,
    tier:           preset.tier,
    domains:        preset.domains,
  });

  console.log(`\n✓ Agent created: ${agent.id}  (${agent.name})`);
  console.log(`  specialization: ${agent.specialization}`);
  console.log(`  domains:        ${(agent.domains as string[]).join(", ") || "(none)"}`);
  console.log(`\n  AGENT_ID=${agent.id}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
