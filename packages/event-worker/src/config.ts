import { loadConfig as loadClaudeWorkerConfig, type ClaudeWorkerConfig } from "@getrelai/claude-worker";

export interface EventWorkerConfig extends ClaudeWorkerConfig {
  // Reconnect backoff for the SSE stream itself (independent of the claude-worker
  // fatal-error backoff, which governs spawn retries after a session fails).
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

export function loadConfig(): EventWorkerConfig {
  const base = loadClaudeWorkerConfig();
  return {
    ...base,
    reconnectBaseMs: Number(process.env.RECONNECT_BASE_MS ?? 2_000),
    reconnectMaxMs:  Number(process.env.RECONNECT_MAX_MS  ?? 60_000),
  };
}
