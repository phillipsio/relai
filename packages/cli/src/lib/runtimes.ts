import { existsSync } from "node:fs";
import { join } from "node:path";

export type WorkerType = "claude" | "copilot" | "cursor" | "windsurf" | "gemini" | "gpt" | "mcp" | "human";

export interface Runtime {
  workerType: WorkerType;
  /** Paths whose presence means this runtime is in use here. */
  markers: (ctx: Paths) => string[];
}

export interface Paths { home: string; repo: string }

export const RUNTIMES: Runtime[] = [
  { workerType: "claude",   markers: ({ home, repo }) => [join(repo, ".claude"), join(repo, ".mcp.json"), join(home, ".claude")] },
  { workerType: "cursor",   markers: ({ home, repo }) => [join(repo, ".cursor"), join(home, ".cursor")] },
  { workerType: "windsurf", markers: ({ home })       => [join(home, ".codeium", "windsurf")] },
  { workerType: "gemini",   markers: ({ home })       => [join(home, ".gemini")] },
  { workerType: "copilot",  markers: ({ home })       => [join(home, ".config", "github-copilot")] },
  { workerType: "gpt",      markers: ({ home })       => [join(home, ".codex")] },
  { workerType: "mcp",      markers: () => [] },
];

// Where each runtime keeps the MCP config it actually reads. A wrong path here
// fails silently: the agent is minted and simply never appears.
export function runtimeTargets(workerType: WorkerType, { home, repo }: Paths): string[] {
  switch (workerType) {
    case "claude":   return [join(repo, ".mcp.json")];
    case "cursor":   return [join(repo, ".cursor", "mcp.json")];
    case "windsurf": return [join(home, ".codeium", "windsurf", "mcp_config.json")];
    case "gemini":   return [join(home, ".gemini", "settings.json")];
    case "copilot":  return [join(home, ".config", "github-copilot", "mcp.json")];
    case "gpt":      return [join(home, ".codex", "mcp.json")];
    case "mcp":      return [join(home, ".config", "relai", "config.json")];
    // A person, not a runtime. Nothing to configure.
    case "human":    return [];
  }
}

// Which agent is running THIS process, from its own environment. Dotfiles only
// say a runtime is installed, which is why join used to offer an agent to every
// tool the machine had ever seen. Returns null when nothing identifies itself;
// the human picks on the approval screen rather than the CLI guessing.
const HOST_MARKERS: [WorkerType, string[]][] = [
  ["claude",   ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]],
  ["cursor",   ["CURSOR_TRACE_ID", "CURSOR_SESSION_ID"]],
  ["windsurf", ["WINDSURF_SESSION_ID", "CODEIUM_SESSION_ID"]],
  ["gemini",   ["GEMINI_CLI", "GEMINI_SESSION_ID"]],
  ["gpt",      ["CODEX_SESSION_ID", "CODEX_SANDBOX"]],
  ["copilot",  ["COPILOT_AGENT_ID"]],
];

export function detectHostRuntime(env: NodeJS.ProcessEnv = process.env): WorkerType | null {
  for (const [worker, keys] of HOST_MARKERS) {
    if (keys.some((k) => env[k])) return worker;
  }
  return null;
}

export function detectRuntimes(paths: Paths): WorkerType[] {
  return RUNTIMES.filter((r) => r.markers(paths).some((m) => existsSync(m))).map((r) => r.workerType);
}

type Json = Record<string, unknown>;

/**
 * Adds one server to an MCP config without disturbing anything else in it.
 * Returns a new object; the input is never modified.
 */
export function mergeMcpServer(existing: Json | null, name: string, entry: Json): Json & { mcpServers: Record<string, unknown> } {
  if (existing === null || existing === undefined) return { mcpServers: { [name]: entry } };
  if (typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("existing config is not a JSON object; refusing to overwrite it");
  }
  const servers = existing.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    throw new Error("existing config has an mcpServers that is not an object; refusing to overwrite it");
  }
  return {
    ...existing,
    mcpServers: { ...(servers as Record<string, unknown> | undefined), [name]: entry },
  };
}
