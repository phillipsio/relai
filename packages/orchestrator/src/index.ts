import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { OrchestratorApiClient } from "./api-client.js";
import { routeTask } from "./router/index.js";
import { runMessageRoutingCycle } from "./message-loop.js";
import { runBlockedTaskWatch } from "./blocked-watcher.js";

const config = loadConfig();
const apiClient = new OrchestratorApiClient(config);
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

console.log(`[orchestrator] Starting — project=${config.projectId} agent=${config.agentId} model=${config.model}`);
console.log(`[orchestrator] Task routing: ${config.pollIntervalMs}ms | Message routing: ${config.messageIntervalMs}ms | Blocked watch: ${config.blockedWatchIntervalMs}ms | Heartbeat: ${config.heartbeatIntervalMs}ms`);

// ── Task routing loop ─────────────────────────────────────────────────────────

async function runTaskRoutingCycle() {
  try {
    const pending = await apiClient.getPendingTasks(config.projectId);
    if (pending.length > 0) {
      console.log(`[orchestrator] ${pending.length} pending task(s) — routing`);
      // Route sequentially to avoid racing on agent availability
      for (const task of pending) {
        await routeTask(task, apiClient, anthropic, config);
      }
    }
  } catch (err) {
    console.error("[orchestrator] Task routing cycle error:", err);
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

async function runHeartbeat() {
  try {
    await apiClient.heartbeat(config.agentId);
  } catch {
    // Non-fatal — API may be momentarily unreachable
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  // Run immediately on startup, then on intervals
  await runTaskRoutingCycle();
  await runMessageRoutingCycle(apiClient, anthropic, config);
  await runBlockedTaskWatch(apiClient, config);
  await runHeartbeat();

  setInterval(runTaskRoutingCycle,                                        config.pollIntervalMs);
  setInterval(() => runMessageRoutingCycle(apiClient, anthropic, config), config.messageIntervalMs);
  setInterval(() => runBlockedTaskWatch(apiClient, config),               config.blockedWatchIntervalMs);
  setInterval(runHeartbeat,                                               config.heartbeatIntervalMs);

  console.log("[orchestrator] Running. Ctrl+C to stop.");
}

main().catch((err) => { console.error(err); process.exit(1); });
