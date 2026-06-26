import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireRelaiEnv } from "./mcpConfig.js";

export interface ServiceSpec {
  label: string;
  agentId: string;
  args: string[];
  env: Record<string, string>;
  workingDirectory: string;
}

export interface InstallOptions {
  repoPath: string;
  specialization?: string;
  model?: string;
}

function labelFor(agentId: string): string {
  return `com.relai.agent.${agentId}`;
}

function resolveClaudeBinDir(): string {
  try {
    const path = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
    if (path) return dirname(path);
  } catch {
    // fall through to a sane default below
  }
  return "/usr/local/bin";
}

// This monorepo has no real build step for execution — shared/* packages
// (e.g. @getrelai/git) export raw TS, so even a compiled dist/cli.js fails
// under plain `node` (ERR_UNKNOWN_FILE_EXTENSION on a sibling package's
// .ts file). Every other package here (API's Docker image included, per
// AGENTS.md) runs via tsx against src/ — match that convention instead of
// depending on dist/, by resolving everything from this package's root
// (the parent of whichever of src/ or dist/ this module is running from).
function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

// Invoke tsx's CLI script directly with the *current* node binary
// (process.execPath) instead of going through the `tsx` shebang script
// (`#!/usr/bin/env node`). On a machine with multiple Node installs,
// `env node` can resolve to a different (and possibly broken — confirmed:
// Homebrew's Node 26 fails to resolve this monorepo's workspace-symlinked TS
// packages under tsx) binary than the one running this installer. Using
// process.execPath guarantees the persistent service runs under the same
// Node that successfully ran `relai-agent install` just now.
function buildSpec(opts: InstallOptions): ServiceSpec {
  const env = requireRelaiEnv(opts.repoPath);
  const claudeDir = resolveClaudeBinDir();
  const safePath = [claudeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

  const root = packageRoot();
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const cliSrc = join(root, "src", "cli.ts");
  const runArgs = [process.execPath, tsxCli, cliSrc, "run", opts.repoPath];
  if (opts.specialization) runArgs.push("--specialization", opts.specialization);
  if (opts.model) runArgs.push("--model", opts.model);

  return {
    label: labelFor(env.AGENT_ID),
    agentId: env.AGENT_ID,
    args: runArgs,
    env: { PATH: safePath },
    workingDirectory: opts.repoPath,
  };
}

export async function installService(opts: InstallOptions): Promise<void> {
  const spec = buildSpec(opts);
  if (process.platform === "darwin") {
    const { installMacOS } = await import("./service-macos.js");
    installMacOS(spec);
  } else if (process.platform === "linux") {
    const { installLinux } = await import("./service-linux.js");
    installLinux(spec);
  } else {
    throw new Error(
      `relai-agent install is not supported on ${process.platform} yet (macOS/launchd and Linux/systemd-user only). ` +
      `Run "relai-agent run ${opts.repoPath}" directly under your own process manager instead.`,
    );
  }
}

export async function uninstallService(repoPath: string): Promise<void> {
  const env = requireRelaiEnv(repoPath);
  const label = labelFor(env.AGENT_ID);
  if (process.platform === "darwin") {
    const { uninstallMacOS } = await import("./service-macos.js");
    uninstallMacOS(label);
  } else if (process.platform === "linux") {
    const { uninstallLinux } = await import("./service-linux.js");
    uninstallLinux(label);
  } else {
    throw new Error(`relai-agent uninstall is not supported on ${process.platform} yet.`);
  }
}

export async function statusService(repoPath: string): Promise<void> {
  const env = requireRelaiEnv(repoPath);
  const label = labelFor(env.AGENT_ID);
  if (process.platform === "darwin") {
    const { statusMacOS } = await import("./service-macos.js");
    statusMacOS(label);
  } else if (process.platform === "linux") {
    const { statusLinux } = await import("./service-linux.js");
    statusLinux(label);
  } else {
    throw new Error(`relai-agent status is not supported on ${process.platform} yet.`);
  }
}
