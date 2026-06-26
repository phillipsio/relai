import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface RelaiServerEnv {
  API_URL?: string;
  API_SECRET?: string;
  AGENT_ID?: string;
  REPO_ID?: string;
}

interface McpServerBlock {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpJson {
  mcpServers?: Record<string, McpServerBlock>;
}

function mcpJsonPath(repoPath: string): string {
  return join(repoPath, ".mcp.json");
}

function readMcpJson(path: string): McpJson {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw) as McpJson;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function readRelaiEnv(repoPath: string): RelaiServerEnv | null {
  const path = mcpJsonPath(repoPath);
  if (!existsSync(path)) return null;
  return readMcpJson(path).mcpServers?.relai?.env ?? null;
}

// True if `path` is tracked by git in its repo — used to warn before writing
// a secret into a file that might get swept up by a careless `git add -A`.
function isGitTracked(path: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", path], { stdio: "ignore" });
    return true;
  } catch {
    return false; // not tracked, not a git repo, or git unavailable — treat as "not tracked"
  }
}

// Merges (or creates) the relai server block in <repoPath>/.mcp.json, preserving
// any other MCP servers already configured there. Writes the file 0600 (it
// carries a live agent token) and warns loudly — but does not refuse — if the
// file is tracked by git, since this is designed to run unattended and a hard
// failure here would defeat that purpose.
export function writeRelaiEnv(repoPath: string, env: Required<RelaiServerEnv>, command: string, args: string[]): void {
  const path = mcpJsonPath(repoPath);
  const json: McpJson = existsSync(path) ? readMcpJson(path) : { mcpServers: {} };
  json.mcpServers = json.mcpServers ?? {};
  json.mcpServers.relai = { command, args, env };
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // belt-and-suspenders: mode on writeFileSync doesn't change an existing file's perms

  if (isGitTracked(path)) {
    console.warn(
      `relai-agent: WARNING — ${path} is tracked by git and now contains a live agent token (API_SECRET). ` +
      `Untrack it ("git rm --cached ${path}") and add ".mcp.json" to .gitignore before committing anything else, ` +
      `or the token will be permanently leaked into git history.`,
    );
  }
}

export function requireRelaiEnv(repoPath: string): Required<RelaiServerEnv> {
  const env = readRelaiEnv(repoPath);
  if (!env || !env.API_SECRET || !env.AGENT_ID || !env.REPO_ID) {
    throw new Error(
      `Could not resolve a relai agent for ${repoPath} — its .mcp.json has no complete "relai" server block.\n` +
      `Run "relai-agent init ${repoPath} --invite <code>" first, or "relai login"/"relai init" if you're using the relai CLI.`,
    );
  }
  return {
    API_URL: env.API_URL ?? "http://localhost:3010",
    API_SECRET: env.API_SECRET,
    AGENT_ID: env.AGENT_ID,
    REPO_ID: env.REPO_ID,
  };
}
