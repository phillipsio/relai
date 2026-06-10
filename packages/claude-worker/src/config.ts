export type Specialization = "reviewer" | "architect" | "writer" | "tester" | "devops";

export interface ClaudeWorkerConfig {
  agentId: string;
  repoId: string;
  apiUrl: string;
  apiSecret: string;
  repoPath: string;
  pollIntervalMs: number;
  maxBackoffMs: number;
  maxTaskRounds: number;
  model: string;
  specialization: Specialization;
  claudeBin: string;
}

export function loadConfig(): ClaudeWorkerConfig {
  const required = ["AGENT_ID", "REPO_ID", "API_SECRET", "REPO_PATH"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(", ")}`);

  const specialization = (process.env.SPECIALIZATION ?? "writer") as Specialization;
  const valid: Specialization[] = ["reviewer", "architect", "writer", "tester", "devops"];
  if (!valid.includes(specialization)) {
    throw new Error(`Invalid SPECIALIZATION "${specialization}". Valid values: ${valid.join(", ")}`);
  }

  return {
    agentId:        process.env.AGENT_ID!,
    repoId:      process.env.REPO_ID!,
    apiUrl:         process.env.API_URL ?? "http://localhost:3010",
    apiSecret:      process.env.API_SECRET!,
    repoPath:       process.env.REPO_PATH!,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS  ?? 15_000),
    maxBackoffMs:   Number(process.env.MAX_BACKOFF_MS    ?? 300_000),
    maxTaskRounds:  Number(process.env.MAX_TASK_ROUNDS   ?? 5),
    model:          process.env.CLAUDE_MODEL ?? "sonnet",
    specialization,
    claudeBin:      process.env.CLAUDE_BIN ?? "claude",
  };
}
