import { resolve as resolvePath } from "node:path";
import type { Specialization } from "@getrelai/claude-worker";
import { runEventWorker, type EventWorkerConfig } from "@getrelai/event-worker";
import { requireRelaiEnv } from "./mcpConfig.js";

export interface RunOptions {
  repoPath: string;
  specialization?: Specialization;
  model?: string;
  claudeBin?: string;
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
    specialization: opts.specialization ?? "writer",
    claudeBin: opts.claudeBin ?? "claude",
    reconnectBaseMs: 2_000,
    reconnectMaxMs: 60_000,
  };

  return runEventWorker(config);
}
