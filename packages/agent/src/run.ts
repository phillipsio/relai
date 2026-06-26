import { resolve as resolvePath } from "node:path";
import { VALID_SPECIALIZATIONS, type Specialization } from "@getrelai/claude-worker";
import { runEventWorker, type EventWorkerConfig } from "@getrelai/event-worker";
import { requireRelaiEnv } from "./mcpConfig.js";

export interface RunOptions {
  repoPath: string;
  specialization?: Specialization;
  model?: string;
  claudeBin?: string;
}

// Resolves the role to run under: an explicit --specialization wins, then
// whatever was persisted at `init` time, then "writer" as the last resort.
// Falling straight to "writer" without checking .mcp.json was the bug — an
// agent registered as e.g. "reviewer" would silently run the writer prompt.
export function resolveSpecialization(opts: RunOptions, persisted?: string): Specialization {
  if (opts.specialization) return opts.specialization;
  if (persisted && VALID_SPECIALIZATIONS.includes(persisted as Specialization)) {
    return persisted as Specialization;
  }
  if (persisted) {
    console.warn(`relai-agent: WARNING — ignoring invalid persisted SPECIALIZATION "${persisted}" in .mcp.json, defaulting to "writer".`);
  }
  return "writer";
}

// The persistent service entrypoint: resolves this repo's agent identity from
// .mcp.json, then runs the push-based event-worker loop in-process (no extra
// process hop) so the agent stays subscribed and reacts to new tasks/messages
// without polling.
export async function runCommand(opts: RunOptions): Promise<never> {
  const repoPath = resolvePath(opts.repoPath);
  const env = requireRelaiEnv(repoPath);

  const config: EventWorkerConfig = {
    agentId: env.AGENT_ID,
    repoId: env.REPO_ID,
    apiUrl: env.API_URL,
    apiSecret: env.API_SECRET,
    repoPath,
    pollIntervalMs: 15_000,
    maxBackoffMs: 300_000,
    maxTaskRounds: 5,
    model: opts.model ?? "sonnet",
    specialization: resolveSpecialization(opts, env.SPECIALIZATION),
    claudeBin: opts.claudeBin ?? "claude",
    reconnectBaseMs: 2_000,
    reconnectMaxMs: 60_000,
  };

  return runEventWorker(config);
}
