import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "./config.js";
import { buildPrompt } from "./prompt.js";

const config = loadConfig();
const mcpServerPath = new URL("../../mcp-server/dist/index.js", import.meta.url).pathname;

console.log(`[claude-worker] Starting — agent ${config.agentId} (${config.specialization}), poll every ${config.pollIntervalMs}ms`);
console.log(`[claude-worker] Repo: ${config.repoPath} | Model: ${config.model}`);

async function heartbeat() {
  await fetch(`${config.apiUrl}/agents/${config.agentId}/heartbeat`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiSecret}` },
    body: "{}",
  }).catch((err) => console.warn("[claude-worker] Heartbeat failed:", err.message));
}

function writeMcpConfig(): string {
  const mcpConfig = {
    mcpServers: {
      relai: {
        command: "node",
        args: [mcpServerPath],
        env: {
          API_URL: config.apiUrl,
          API_SECRET: config.apiSecret,
          AGENT_ID: config.agentId,
          PROJECT_ID: config.projectId,
        },
      },
    },
  };
  const path = join(tmpdir(), `claude-worker-${config.agentId}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(mcpConfig));
  return path;
}

async function runSession(): Promise<void> {
  const prompt = buildPrompt(config);
  const mcpConfigPath = writeMcpConfig();

  try {
    await new Promise<void>((resolve, reject) => {
      const args = [
        "--print",
        "--mcp-config", mcpConfigPath,
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
        "--verbose",
        "--model", config.model,
        "--add-dir", config.repoPath,
      ];

      console.log(`[claude-worker] Spawning: ${config.claudeBin} ${args.slice(0, 4).join(" ")} ...`);
      console.log(`[claude-worker] cwd: ${config.repoPath}`);

      const proc = spawn(config.claudeBin, args, {
        cwd: config.repoPath,
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
      });

      console.log(`[claude-worker] Process PID: ${proc.pid}`);
      proc.stdin.write(prompt);
      proc.stdin.end();

      const toolsUsed: string[] = [];
      let buffer = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.type === "assistant") {
              const content = ((event.message as Record<string, unknown>)?.content ?? []) as Array<Record<string, unknown>>;
              for (const block of content) {
                if (block.type === "tool_use") {
                  const name = block.name as string;
                  toolsUsed.push(name);
                  process.stdout.write(`  ⚙  ${name}\n`);
                } else if (block.type === "text") {
                  process.stdout.write(".");
                }
              }
            } else if (event.type === "result" && event.is_error) {
              console.error(`[claude-worker] Session failed: ${event.result}`);
            }
          } catch { /* non-JSON line */ }
        }
      });

      let stderrOutput = "";
      proc.stderr.on("data", (chunk: Buffer) => { stderrOutput += chunk.toString(); });
      proc.stderr.on("end", () => {
        if (stderrOutput.trim()) console.error(`[claude-worker] stderr: ${stderrOutput.trim()}`);
      });

      proc.on("close", (code) => {
        const unique = [...new Set(toolsUsed)];
        console.log(`[claude-worker] Done — tools used: ${unique.length ? unique.join(", ") : "none"}`);
        if (code !== 0 && code !== null) {
          reject(new Error(`claude exited with code ${code}`));
        } else {
          resolve();
        }
      });

      proc.on("error", reject);
    });
  } finally {
    try { unlinkSync(mcpConfigPath); } catch { /* ignore */ }
  }
}

async function main() {
  while (true) {
    await heartbeat();
    try {
      console.log("[claude-worker] Running session...");
      await runSession();
    } catch (err) {
      console.error("[claude-worker] Session error:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

main().catch((err) => {
  console.error("[claude-worker] Fatal:", err);
  process.exit(1);
});
