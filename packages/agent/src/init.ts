import { resolve as resolvePath } from "node:path";
import { getGitRoot, getOriginUrl, normalizeRepoUrl } from "@getrelai/git";
import { writeRelaiEnv, readRelaiEnv } from "./mcpConfig.js";

export interface InitOptions {
  repoPath: string;
  apiUrl: string;
  invite: string;
  name?: string;
  specialization?: string;
}

async function acceptInvite(apiUrl: string, body: {
  code: string;
  name: string;
  role: "worker";
  specialization?: string;
  workerType: "mcp";
}): Promise<{ agent: { id: string; name: string; repoId: string }; token: string }> {
  const res = await fetch(`${apiUrl}/auth/accept-invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`accept-invite failed (${res.status} ${res.statusText}): ${text}`);
  }
  const json = (await res.json()) as { data: { id: string; name: string; repoId: string }; token: string };
  return { agent: json.data, token: json.token };
}

// Self-registers a fresh agent against a repo invite and wires the result into
// the target repo's .mcp.json — the non-interactive counterpart to `relai login`,
// designed to run unattended (no prompts) so a worker can onboard itself.
export async function initCommand(opts: InitOptions): Promise<void> {
  const repoPath = resolvePath(opts.repoPath);

  const existing = readRelaiEnv(repoPath);
  if (existing?.AGENT_ID) {
    console.log(`relai-agent: ${repoPath} is already wired to agent ${existing.AGENT_ID} — nothing to do.`);
    console.log(`Delete the "relai" block from ${repoPath}/.mcp.json to re-init.`);
    return;
  }

  const gitRoot = getGitRoot(repoPath);
  if (!gitRoot) {
    throw new Error(`${repoPath} is not a git repository — clone the target repo first.`);
  }
  const origin = getOriginUrl(gitRoot);

  const name = opts.name ?? `relai-agent-${process.env.USER ?? "worker"}`;
  const { agent, token } = await acceptInvite(opts.apiUrl, {
    code: opts.invite,
    name,
    role: "worker",
    specialization: opts.specialization,
    workerType: "mcp",
  });

  writeRelaiEnv(
    gitRoot,
    { API_URL: opts.apiUrl, API_SECRET: token, AGENT_ID: agent.id, REPO_ID: agent.repoId },
    "npx",
    ["@getrelai/mcp-server"],
  );

  console.log(`relai-agent: registered "${agent.name}" (${agent.id}) for repo ${agent.repoId}`);
  console.log(`  wrote .mcp.json in ${gitRoot}`);
  if (origin) console.log(`  origin: ${normalizeRepoUrl(origin)}`);
  console.log(`\nNext: relai-agent install ${gitRoot}`);
}
