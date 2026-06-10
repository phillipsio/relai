import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { MCPServerConfig } from "@github/copilot-sdk";
import { loadConfig } from "./config.js";
import { buildPrompt } from "./prompt.js";
import { checkRepoMatch, fetchRepoUrl } from "@getrelai/git";

// Refuse to start if REPO_PATH isn't a clone of this agent's repo. No-ops when
// the repo has no url or under RELAI_SKIP_REPO_CHECK; an unreachable API just
// skips the check rather than blocking startup on a network blip.
async function assertRepoOrExit(config: ReturnType<typeof loadConfig>): Promise<void> {
  const repoUrl = await fetchRepoUrl(config.apiUrl, config.repoId, config.apiSecret);
  const check = checkRepoMatch(config.repoPath, repoUrl);
  if (!check.ok) {
    console.error(`[copilot-worker] Repo check failed: ${check.reason}\n  ${check.fix}`);
    process.exit(1);
  }
}

async function main() {
  const config = loadConfig();

  console.log(`[copilot-worker] Starting — agent ${config.agentId}, poll every ${config.pollIntervalMs}ms`);

  await assertRepoOrExit(config);

  const client = new CopilotClient();
  await client.start();

  process.on("SIGINT", async () => {
    console.log("\n[copilot-worker] Shutting down...");
    await client.stop();
    process.exit(0);
  });

  while (true) {
    try {
      await runIteration(client, config);
    } catch (err) {
      console.error("[copilot-worker] Iteration error:", err);
    }
    await sleep(config.pollIntervalMs);
  }
}

async function heartbeat(config: ReturnType<typeof loadConfig>) {
  await fetch(`${config.apiUrl}/agents/${config.agentId}/heartbeat`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiSecret}` },
    body: "{}",
  }).catch((err) => console.warn("[copilot-worker] Heartbeat failed:", err.message));
}

async function runIteration(client: CopilotClient, config: ReturnType<typeof loadConfig>) {
  await heartbeat(config);
  const prompt = buildPrompt(config);

  const session = await client.createSession({
    workingDirectory: config.repoPath,
    onPermissionRequest: approveAll,
    model: config.model,
    mcpServers: buildMcpServers(config),
  });

  const toolsUsed: string[] = [];

  session.on("tool.execution_start", (event) => {
    toolsUsed.push(event.data.toolName);
    console.log(`  ⚙  ${event.data.toolName}`);
  });

  session.on("assistant.message", () => {
    process.stdout.write(".");
  });

  console.log("[copilot-worker] Running session...");
  await session.sendAndWait({ prompt }, 300_000);
  await session.destroy();

  if (toolsUsed.length) {
    console.log(`\n[copilot-worker] Done — tools used: ${toolsUsed.join(", ")}`);
  } else {
    console.log("[copilot-worker] No tools used — queue likely empty");
  }
}

function buildMcpServers(config: ReturnType<typeof loadConfig>): Record<string, MCPServerConfig> {
  const mcpServerPath = new URL("../../mcp-server/dist/index.js", import.meta.url).pathname;
  return {
    relai: {
      command: "node",
      args: [mcpServerPath],
      env: {
        ORCHESTRATOR_API_URL: config.apiUrl,
        ORCHESTRATOR_API_SECRET: config.apiSecret,
        AGENT_ID: config.agentId,
        REPO_ID: config.repoId,
      },
      tools: ["*"],
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[copilot-worker] Fatal:", err);
  process.exit(1);
});
