export interface CopilotWorkerConfig {
  githubToken: string;
  agentId: string;
  projectId: string;
  apiUrl: string;
  apiSecret: string;
  repoPath: string;
  mcpConfigPath: string;
  pollIntervalMs: number;
  maxIterations: number;
  model: string;
}

export function loadConfig(): CopilotWorkerConfig {
  const required = ["GITHUB_TOKEN", "AGENT_ID", "PROJECT_ID", "ORCHESTRATOR_API_SECRET", "REPO_PATH"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(", ")}`);

  return {
    githubToken: process.env.GITHUB_TOKEN!,
    agentId: process.env.AGENT_ID!,
    projectId: process.env.PROJECT_ID!,
    apiUrl: process.env.ORCHESTRATOR_API_URL ?? "http://localhost:3010",
    apiSecret: process.env.ORCHESTRATOR_API_SECRET!,
    repoPath: process.env.REPO_PATH!,
    mcpConfigPath: process.env.MCP_CONFIG_PATH ?? `${process.env.HOME}/.claude.json`,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15_000),
    maxIterations: Number(process.env.MAX_ITERATIONS ?? 10),
    model: process.env.COPILOT_MODEL ?? "gpt-4.1",
  };
}
