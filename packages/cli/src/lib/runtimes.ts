import { existsSync } from "node:fs";
import { join } from "node:path";

export type WorkerType = "claude" | "copilot" | "cursor" | "windsurf" | "gemini" | "gpt" | "mcp";

export interface Runtime {
  workerType: WorkerType;
  label: string;
  /** Paths whose presence means this runtime is in use here. */
  markers: (ctx: Paths) => string[];
}

export interface Paths { home: string; repo: string }

export const RUNTIMES: Runtime[] = [
  { workerType: "claude",   label: "Claude Code", markers: ({ home, repo }) => [join(repo, ".claude"), join(repo, ".mcp.json"), join(home, ".claude")] },
  { workerType: "cursor",   label: "Cursor",      markers: ({ home, repo }) => [join(repo, ".cursor"), join(home, ".cursor")] },
  { workerType: "windsurf", label: "Windsurf",    markers: ({ home })       => [join(home, ".codeium", "windsurf")] },
  { workerType: "gemini",   label: "Gemini",      markers: ({ home })       => [join(home, ".gemini")] },
  { workerType: "copilot",  label: "Copilot",     markers: ({ home })       => [join(home, ".config", "github-copilot")] },
  { workerType: "gpt",      label: "GPT",         markers: ({ home })       => [join(home, ".codex")] },
  { workerType: "mcp",      label: "Other MCP client", markers: () => [] },
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
  }
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
