import { join } from "node:path";

export type WorkerType = "claude" | "copilot" | "cursor" | "windsurf" | "gemini" | "gpt" | "mcp" | "human";

export interface Paths { home: string; repo: string }

export const RUNTIMES: WorkerType[] = ["claude", "cursor", "windsurf", "gemini", "copilot", "gpt", "mcp"];

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

// Only entries measured against a live process. A guess and an absent entry both
// return null, but a guess also looks like coverage.
const HOST_MARKERS: [WorkerType, string[]][] = [
  ["claude", ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]],
  ["cursor", ["CURSOR_INVOKED_AS"]],
];

export function detectHostRuntime(env: NodeJS.ProcessEnv = process.env): WorkerType | null {
  for (const [worker, keys] of HOST_MARKERS) {
    if (keys.some((k) => env[k])) return worker;
  }
  return null;
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
