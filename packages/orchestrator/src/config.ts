export interface OrchestratorConfig {
  apiUrl: string;
  apiSecret: string;
  agentId: string;
  projectId: string;
  anthropicApiKey: string | null;
  model: string;
  pollIntervalMs: number;
  escalationIntervalMs: number;
  heartbeatIntervalMs: number;
  messageIntervalMs: number;
  blockedWatchIntervalMs: number;
  maxTaskRounds: number;
}

export function loadConfig(): OrchestratorConfig {
  const required = {
    ORCHESTRATOR_API_URL:    process.env.ORCHESTRATOR_API_URL    ?? "http://localhost:3010",
    ORCHESTRATOR_API_SECRET: process.env.ORCHESTRATOR_API_SECRET,
    AGENT_ID:                process.env.AGENT_ID,
    PROJECT_ID:              process.env.PROJECT_ID,
  };

  for (const [key, val] of Object.entries(required)) {
    if (!val) {
      console.error(`[orchestrator] Missing required env var: ${key}`);
      process.exit(1);
    }
  }

  return {
    apiUrl:               required.ORCHESTRATOR_API_URL,
    apiSecret:            required.ORCHESTRATOR_API_SECRET!,
    agentId:              required.AGENT_ID!,
    projectId:            required.PROJECT_ID!,
    anthropicApiKey:      process.env.ANTHROPIC_API_KEY ?? null,
    model:                process.env.ORCHESTRATOR_MODEL ?? "claude-opus-4-6",
    pollIntervalMs:       Number(process.env.POLL_INTERVAL_MS        ?? 15_000),
    escalationIntervalMs: Number(process.env.ESCALATION_INTERVAL_MS  ?? 30_000),
    heartbeatIntervalMs:  Number(process.env.HEARTBEAT_INTERVAL_MS   ?? 60_000),
    messageIntervalMs:       Number(process.env.MESSAGE_INTERVAL_MS        ?? 10_000),
    blockedWatchIntervalMs:  Number(process.env.BLOCKED_WATCH_INTERVAL_MS  ?? 15_000),
    maxTaskRounds:           Number(process.env.MAX_TASK_ROUNDS ?? 5),
  };
}
