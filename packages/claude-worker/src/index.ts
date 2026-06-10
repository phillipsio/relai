import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "./config.js";
import { buildPrompt } from "./prompt.js";
import { isFatalError } from "./errors.js";

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
          REPO_ID: config.repoId,
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
      let resultError = "";

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
              resultError = String(event.result ?? "");
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
          // Surface the result-error / stderr text so the loop can classify the
          // failure (fatal credential/credit issue vs transient).
          const detail = (resultError || stderrOutput || "").trim();
          reject(new Error(`claude exited with code ${code}${detail ? `: ${detail}` : ""}`));
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
  let consecutiveFatal = 0;
  while (true) {
    await heartbeat();
    let delay = config.pollIntervalMs;
    try {
      console.log("[claude-worker] Running session...");
      await runSession();
      consecutiveFatal = 0;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (isFatalError(text)) {
        // A credential/credit failure won't clear by re-spawning in 15s — that
        // just burns a tight loop (this bit us when a worker ran out of credits
        // and respawned every poll). Back off exponentially, capped, and warn
        // loudly so a human can fix it; resume automatically once it clears.
        consecutiveFatal++;
        delay = Math.min(config.maxBackoffMs, config.pollIntervalMs * 2 ** consecutiveFatal);
        console.error(
          `[claude-worker] FATAL error (likely exhausted credits or bad credentials) — ` +
          `backing off ${Math.round(delay / 1000)}s before retry #${consecutiveFatal}. ` +
          `Fix the credit/credential issue; the worker will resume automatically.\n  ${text}`,
        );
      } else {
        consecutiveFatal = 0;
        console.error("[claude-worker] Session error:", text);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

main().catch((err) => {
  console.error("[claude-worker] Fatal:", err);
  process.exit(1);
});
