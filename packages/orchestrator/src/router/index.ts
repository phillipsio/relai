import Anthropic from "@anthropic-ai/sdk";
import type { OrchestratorApiClient, TaskRow } from "../api-client.js";
import type { OrchestratorConfig } from "../config.js";
import { tryRulesRouting } from "./rules.js";
import { claudeRouting } from "./claude.js";

export async function routeTask(
  task: TaskRow,
  apiClient: OrchestratorApiClient,
  anthropic: Anthropic,
  config: OrchestratorConfig
): Promise<void> {
  const [agents, taskCounts] = await Promise.all([
    apiClient.getWorkerAgents(config.projectId),
    apiClient.getActiveTaskCounts(config.projectId),
  ]);

  if (agents.length === 0) {
    console.warn(`[router] No worker agents available for task ${task.id} — skipping`);
    return;
  }

  // Tier 1: rules (free)
  let result = tryRulesRouting(task, agents, taskCounts);

  // Tier 2: Claude (costs tokens, only when rules can't resolve)
  if (!result) {
    console.log(`[router] Rules couldn't resolve task ${task.id} — escalating to Claude`);
    try {
      result = await claudeRouting(task, agents, anthropic, config.model);
    } catch (err) {
      console.error(`[router] Claude routing failed for task ${task.id}:`, err);
      return;  // leave as pending, retry next cycle
    }
  }

  // UNROUTABLE — no agent fits, leave pending and log
  if (result.agentId === "UNROUTABLE") {
    console.warn(`[router] Task ${task.id} is unroutable: ${result.rationale}`);
    return;
  }

  // Assign
  await apiClient.assignTask(task.id, result.agentId);
  await apiClient.logRouting({
    taskId: task.id,
    assignedTo: result.agentId,
    method: result.method,
    rationale: result.rationale,
  });

  console.log(
    `[router] Assigned task ${task.id} → agent ${result.agentId} ` +
    `(${result.method}) — ${result.rationale}`
  );
}
