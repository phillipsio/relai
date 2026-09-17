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

// Every path this agent's token might sit in. Deliberately wider than
// runtimeTargets, which is what `join` WRITES: ~/.claude.json is somewhere the
// invite snippet and AGENTS.md tell people to put the entry by hand, so rotation
// must look there even though join never writes it. Scanning a path costs
// nothing; missing one leaves a client holding a revoked token.
export function allRuntimeTargets({ home, repo }: Paths): string[] {
  const fromRuntimes = RUNTIMES.flatMap((w) => runtimeTargets(w, { home, repo }));
  return [...new Set([...fromRuntimes, join(home, ".claude.json")])];
}

/**
 * Does this config hold that exact token for relai? Checks the top-level
 * mcpServers and ~/.claude.json's per-project scopes. Never throws: it is run
 * across every known runtime path, most of which belong to other tools.
 */
export function holdsRelaiToken(existing: unknown, token: string): boolean {
  if (typeof token !== "string" || token === "") return false;
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) return false;

  const scopes: unknown[] = [existing];
  const projects = (existing as Json).projects;
  if (typeof projects === "object" && projects !== null && !Array.isArray(projects)) {
    scopes.push(...Object.values(projects as Json));
  }

  return scopes.some((scope) => {
    if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return false;
    const servers = (scope as Json).mcpServers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return false;
    const relai = (servers as Json).relai;
    if (typeof relai !== "object" || relai === null || Array.isArray(relai)) return false;
    const env = (relai as Json).env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) return false;
    return (env as Json).API_SECRET === token;
  });
}
