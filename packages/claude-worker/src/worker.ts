import { classifySessionError } from "./errors.js";
import { blockOverflowedTasks } from "./block-task.js";
import { runClaudeSession } from "./session.js";
import { checkRepoMatch, fetchRepoUrl } from "@getrelai/git";
import type { ClaudeWorkerConfig } from "./config.js";

// Shared with @getrelai/event-worker (same heartbeat/repo-check logic, just a
// different log prefix) so the two loop implementations don't carry byte-
// identical copies of this code.
export async function heartbeat(config: ClaudeWorkerConfig, logPrefix = "[claude-worker]") {
  await fetch(`${config.apiUrl}/agents/${config.agentId}/heartbeat`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiSecret}` },
    body: "{}",
  }).catch((err) => console.warn(`${logPrefix} Heartbeat failed:`, err.message));
}

// Refuse to start if REPO_PATH isn't a clone of this agent's repo — a worker in
// the wrong tree produces garbage commits. No-ops when the repo has no url or
// under RELAI_SKIP_REPO_CHECK; an unreachable API just skips the check (don't
// block startup on a transient network blip).
export async function assertRepoOrExit(config: ClaudeWorkerConfig, logPrefix = "[claude-worker]"): Promise<void> {
  const repoUrl = await fetchRepoUrl(config.apiUrl, config.repoId, config.apiSecret);
  const check = checkRepoMatch(config.repoPath, repoUrl);
  if (!check.ok) {
    console.error(`${logPrefix} Repo check failed: ${check.reason}\n  ${check.fix}`);
    process.exit(1);
  }
}

// The worker's poll-run-backoff loop, factored out so other packages (e.g.
// @getrelai/agent, which wraps this in a self-registering persistent service)
// can run it in-process instead of spawning a second `claude-worker` process.
export async function runWorker(config: ClaudeWorkerConfig): Promise<never> {
  console.log(`[claude-worker] Starting — agent ${config.agentId} (${config.specialization}), poll every ${config.pollIntervalMs}ms`);
  console.log(`[claude-worker] Repo: ${config.repoPath} | Model: ${config.model}`);

  await assertRepoOrExit(config);
  let consecutiveFatal = 0;
  while (true) {
    await heartbeat(config);
    let delay = config.pollIntervalMs;
    try {
      console.log("[claude-worker] Running session...");
      await runClaudeSession(config);
      consecutiveFatal = 0;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      const failure = classifySessionError(text);

      // Retiring the task beats backing off — a wait makes it no smaller.
      // Backoff is the fallback when there is nothing to retire.
      const blocked = failure === "overflow" ? await blockOverflowedTasks(config, text) : [];

      if (blocked.length > 0) {
        consecutiveFatal = 0;
        console.error(
          `[claude-worker] Session ran out of context — blocked ${blocked.join(", ")} pending a split.\n  ${text}`,
        );
      } else if (failure === "transient") {
        consecutiveFatal = 0;
        console.error("[claude-worker] Session error:", text);
      } else {
        consecutiveFatal++;
        delay = Math.min(config.maxBackoffMs, config.pollIntervalMs * 2 ** consecutiveFatal);
        const cause = failure === "overflow"
          ? "context overflow with no task in flight to block"
          : "likely exhausted credits or bad credentials";
        console.error(
          `[claude-worker] FATAL error (${cause}) — ` +
          `backing off ${Math.round(delay / 1000)}s before retry #${consecutiveFatal}. ` +
          `Fix the underlying issue; the worker will resume automatically.\n  ${text}`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
