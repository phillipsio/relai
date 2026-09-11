import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { detectRuntimes, mergeMcpServer, runtimeTargets, RUNTIMES, type WorkerType } from "../lib/runtimes.js";
import { writeConfig } from "../config.js";

const DEFAULT_API = "https://api.relai.dev";
const MCP_SERVER_PACKAGE = "@getrelai/mcp-server";

interface StartResponse {
  data: { userCode: string; verificationUri: string; expiresIn: number; interval: number };
  deviceCode: string;
}
interface GrantedInvite {
  name: string; workerType: WorkerType; role: "orchestrator" | "worker";
  specialization: string | null; domains: string[]; code: string;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function describeRepo(cwd: string) {
  const root = git(["rev-parse", "--show-toplevel"], cwd) ?? cwd;
  const remote = git(["remote", "get-url", "origin"], root);
  const fromRemote = remote?.replace(/\.git$/, "").split(/[/:]/).pop();
  return { root, remote: remote ?? undefined, repoName: fromRemote || basename(root) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, body: unknown, token?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let payload: Record<string, unknown> = {};
  try { payload = await res.json() as Record<string, unknown>; } catch { /* non-JSON error body */ }
  return { status: res.status, payload };
}

function writeMcpConfig(target: string, entry: Record<string, unknown>) {
  let existing: Record<string, unknown> | null = null;
  if (existsSync(target)) {
    const raw = readFileSync(target, "utf-8").trim();
    if (raw) {
      try {
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Refuse rather than replace. A config we cannot parse is still one the
        // user can fix, and overwriting it loses whatever was in there.
        throw new Error(`${target} is not valid JSON; fix or move it, then run join again`);
      }
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(mergeMcpServer(existing, "relai", entry), null, 2) + "\n");
  chmodSync(target, 0o600);
}

/** Keeps a token out of git when the file sits inside the repo and is untracked. */
function excludeIfUntracked(repoRoot: string, target: string) {
  if (!target.startsWith(repoRoot + "/")) return;
  const rel = target.slice(repoRoot.length + 1);
  if (git(["check-ignore", "-q", rel], repoRoot) !== null) return;
  if (git(["ls-files", "--error-unmatch", rel], repoRoot) !== null) return;
  const dir = git(["rev-parse", "--git-common-dir"], repoRoot);
  if (!dir) return;
  const exclude = join(dir.startsWith("/") ? dir : join(repoRoot, dir), "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  const body = existsSync(exclude) ? readFileSync(exclude, "utf-8") : "";
  if (!body.split("\n").some((l) => l.trim() === rel)) appendFileSync(exclude, `\n${rel}\n`);
}

export async function joinCommand(opts: { api?: string }) {
  const api = (opts.api ?? DEFAULT_API).replace(/\/+$/, "");
  const cwd = process.cwd();
  const { root, remote, repoName } = describeRepo(cwd);
  const home = homedir();
  const runtimes = detectRuntimes({ home, repo: root });

  console.log(chalk.bold("\nrelai join\n"));
  console.log(`  Repo      ${chalk.cyan(repoName)}${remote ? chalk.dim(`  (${remote})`) : ""}`);
  console.log(`  Detected  ${runtimes.length ? runtimes.join(", ") : chalk.dim("nothing; you can still pick on the next screen")}`);

  const started = await postJson(`${api}/auth/device/start`, { proposed: { repoName, remote, runtimes } });
  if (started.status !== 201) {
    console.error(chalk.red(`\n  Could not reach relai at ${api} (HTTP ${started.status})`));
    process.exit(1);
  }
  const { data, deviceCode } = started.payload as unknown as StartResponse;

  console.log(`\n  Open      ${chalk.bold(data.verificationUri)}`);
  console.log(`  Code      ${chalk.bold(data.userCode)}   ${chalk.dim(`expires in ${Math.round(data.expiresIn / 60)} minutes`)}`);
  console.log(chalk.dim("\n  Type the code yourself; relai will show you what it is about to grant.\n"));
  console.log(chalk.dim("  Waiting for approval…"));

  let interval = data.interval * 1000;
  const deadline = Date.now() + data.expiresIn * 1000;
  let invites: GrantedInvite[] | null = null;
  let repoId = "";

  while (Date.now() < deadline) {
    await sleep(interval);
    const res = await postJson(`${api}/auth/device/token`, {}, deviceCode);
    const code = (res.payload as { error?: { code?: string } }).error?.code;
    if (res.status === 200) {
      invites = (res.payload as { invites: GrantedInvite[] }).invites;
      repoId = (res.payload as { data: { repoId: string } }).data.repoId;
      break;
    }
    if (code === "slow_down") { interval += 5000; continue; }
    if (code === "authorization_pending") continue;
    console.error(chalk.red(`\n  ${code === "access_denied" ? "Declined in the browser." : "That code is no longer usable."} Run join again for a fresh one.`));
    process.exit(1);
  }
  if (!invites) {
    console.error(chalk.red("\n  Timed out waiting for approval. Run join again."));
    process.exit(1);
  }

  console.log("");
  const connected: { name: string; workerType: WorkerType; targets: string[] }[] = [];
  for (const invite of invites) {
    const accepted = await postJson(`${api}/auth/accept-invite`, {
      code: invite.code, name: invite.name, role: invite.role,
      specialization: invite.specialization ?? undefined,
      workerType: invite.workerType, domains: invite.domains ?? [],
    });
    if (accepted.status !== 201) {
      console.error(chalk.red(`  ✕ ${invite.name}: could not redeem (HTTP ${accepted.status})`));
      continue;
    }
    const agent = (accepted.payload as { data: { id: string }; token: string });
    const env = { API_URL: api, API_SECRET: agent.token, AGENT_ID: agent.data.id, REPO_ID: repoId };

    const targets = runtimeTargets(invite.workerType, { home, repo: root });
    for (const target of targets) {
      if (invite.workerType === "mcp") {
        writeConfig({ apiUrl: api, apiToken: agent.token, agentId: agent.data.id, agentName: invite.name, repoId, specialization: invite.specialization ?? undefined });
        chmodSync(target, 0o600);
      } else {
        writeMcpConfig(target, { command: "npx", args: ["-y", MCP_SERVER_PACKAGE], env });
      }
      excludeIfUntracked(root, target);
    }
    connected.push({ name: invite.name, workerType: invite.workerType, targets });
    console.log(`  ${chalk.green("✓")} ${invite.name} ${chalk.dim(`(${invite.role}${invite.specialization ? `, ${invite.specialization}` : ""})`)}`);
  }

  if (connected.length === 0) {
    console.error(chalk.red("\n  Nothing was connected."));
    process.exit(1);
  }

  console.log(chalk.bold("\n  You're in.\n"));
  console.log(`  repo      ${chalk.cyan(repoName)}`);
  console.log(`  agents    ${connected.map((c) => c.name).join(", ")}`);
  console.log(`  api       ${api}`);
  console.log(`  wrote     ${[...new Set(connected.flatMap((c) => c.targets))].map((t) => t.replace(home, "~")).join("\n            ")}`);
  console.log(chalk.yellow("\n  Restart these sessions before using relai."));
  console.log(chalk.dim("  A running MCP client keeps the tool schema it got at initialize.\n"));
}
