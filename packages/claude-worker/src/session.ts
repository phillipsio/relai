import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { buildPrompt } from "./prompt.js";
import type { ClaudeWorkerConfig } from "./config.js";

function mcpServerEntry(): string {
  return fileURLToPath(new URL("../../mcp-server/src/index.ts", import.meta.url));
}

// Invoke tsx's CLI script directly with the *current* node binary
// (process.execPath) instead of going through the `tsx` shebang script
// (`#!/usr/bin/env node`) — see packages/agent/src/service.ts for the same
// pattern and why: on a machine with multiple Node installs, `env node` can
// resolve to a different (and possibly broken) binary than the one running
// this worker.
function mcpServerTsxCli(): string {
  return fileURLToPath(new URL("../../mcp-server/node_modules/tsx/dist/cli.mjs", import.meta.url));
}

function writeMcpConfig(config: ClaudeWorkerConfig): string {
  const mcpConfig = {
    mcpServers: {
      relai: {
        command: process.execPath,
        args: [mcpServerTsxCli(), mcpServerEntry()],
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

// One headless `claude --print` pass: read inbox/tasks, act, exit. Callers
// decide cadence — a poll loop (claude-worker) or an event trigger (event-worker).
export async function runClaudeSession(config: ClaudeWorkerConfig): Promise<void> {
  const prompt = buildPrompt(config);
  const mcpConfigPath = writeMcpConfig(config);

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

      // Strip API-key auth so the CLI always falls back to its subscription/OAuth
      // login, even if the parent shell has ANTHROPIC_API_KEY set for unrelated
      // work — the worker should never silently bill API credits.
      const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...workerEnv } = process.env;

      const proc = spawn(config.claudeBin, args, {
        cwd: config.repoPath,
        env: { ...workerEnv, PATH: process.env.PATH },
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
          // Surface the result-error / stderr text so the caller can classify the
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
