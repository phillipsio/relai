import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { detectHostRuntime, mergeMcpServer, runtimeTargets, type WorkerType } from "../lib/runtimes.js";
import { writeConfig, configPath as cliConfigPath } from "../config.js";
import { MCP_SERVER_ENTRY } from "../lib/mcp-entry.js";

const DEFAULT_API = "https://api.pitboss.dev";


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

async function getJson(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  let payload: Record<string, unknown> = {};
  try { payload = await res.json() as Record<string, unknown>; } catch { /* non-JSON error body */ }
  return { status: res.status, payload };
}

// Each agent messages the next and the recipient reads it back. One pass proves
// every token authenticates, and that threads, delivery and the read path work.
async function handshake(api: string, repoId: string, team: { name: string; id: string; token: string }[]) {
  if (team.length === 1) {
    const solo = team[0];
    const probe = await getJson(`${api}/messages/unread?agentId=${encodeURIComponent(solo.id)}&repoId=${encodeURIComponent(repoId)}`, solo.token);
    return { attempted: 1, delivered: probe.status === 200 ? 1 : 0, solo: true };
  }
  let delivered = 0;
  for (let i = 0; i < team.length; i++) {
    const from = team[i];
    const to = team[(i + 1) % team.length];
    const sent = await postJson(`${api}/agents/${to.id}/messages`, { type: "status", body: "ping from onboarding" }, from.token);
    if (sent.status !== 201) continue;
    const inbox = await getJson(`${api}/messages/unread?agentId=${encodeURIComponent(to.id)}&repoId=${encodeURIComponent(repoId)}`, to.token);
    const rows = (inbox.payload as { data?: { body?: string }[] }).data ?? [];
    if (inbox.status === 200 && rows.some((m) => m.body === "ping from onboarding")) delivered++;
  }
  return { attempted: team.length, delivered };
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
  // Random, not the pid: a predictable name in a writable directory lets someone
  // pre-place a symlink. `wx` refuses an existing path instead of following it.
  const tmp = `${target}.relai-${randomBytes(8).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(mergeMcpServer(existing, "relai", entry), null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, target);
}

function isTracked(rawTarget: string): boolean {
  // Resolve first: a leaf symlink into a dotfiles repo is tracked even though
  // the path we were handed is not.
  const target = existsSync(rawTarget) ? realpathSync(rawTarget) : rawTarget;
  const dir = dirname(target);
  const root = git(["rev-parse", "--show-toplevel"], dir);
  if (!root) return false;
  return git(["ls-files", "--error-unmatch", target], root) !== null;
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
  try {
    await run(opts);
  } catch (err) {
    console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

async function run(opts: { api?: string }) {
  const api = (opts.api ?? DEFAULT_API).replace(/\/+$/, "");
  const cwd = process.cwd();
  const { root, remote, repoName } = describeRepo(cwd);
  const home = homedir();
  const host = detectHostRuntime();

  console.log(chalk.bold("\npitboss join\n"));
  console.log(`  Repo      ${chalk.cyan(repoName)}${remote ? chalk.dim(`  (${remote})`) : ""}`);
  console.log(`  Agent     ${host ? chalk.cyan(host) : chalk.dim("unknown, pick it on the approval screen")}  ${chalk.dim("(orchestrator)")}`);
  console.log(chalk.dim("            Add the rest later; they each want their own worktree."));

  const started = await postJson(`${api}/auth/device/start`, {
    proposed: { repoName, remote, host: host ?? undefined },
  });
  if (started.status !== 201) {
    console.error(chalk.red(started.status === 429
      ? "\n  Too many join requests from your network just now. Wait a minute and try again."
      : `\n  Could not reach pitboss at ${api} (HTTP ${started.status})`));
    process.exit(1);
  }
  const { data, deviceCode } = started.payload as unknown as StartResponse;

  console.log(`\n  Open      ${chalk.bold(data.verificationUri)}`);
  console.log(`  Code      ${chalk.bold(data.userCode)}   ${chalk.dim(`expires in ${Math.round(data.expiresIn / 60)} minutes`)}`);
  console.log(chalk.dim("\n  Type the code yourself; the approval screen shows what it will grant.\n"));
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
  const team: { name: string; id: string; token: string }[] = [];
  const skipped: { name: string; target: string }[] = [];
  const failed: { name: string; id: string; why: string }[] = [];
  let wroteCliConfig = "";
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

    const targets = runtimeTargets(invite.workerType, { home, repo: root }) ?? [];
    const written: string[] = [];
    try {
      for (const target of targets) {
        // The mcp branch writes wherever RELAI_CONFIG_DIR points, which is not
        // the nominal target, so the tracked check has to follow the real path.
        const dest = invite.workerType === "mcp" ? cliConfigPath() : target;
        if (isTracked(dest)) {
          skipped.push({ name: invite.name, target: dest });
          continue;
        }
        if (invite.workerType === "mcp") {
          if (wroteCliConfig) {
            skipped.push({ name: invite.name, target: `${dest} (already holds ${wroteCliConfig})` });
            continue;
          }
          writeConfig({ apiUrl: api, apiToken: agent.token, agentId: agent.data.id, agentName: invite.name, repoId, specialization: invite.specialization ?? undefined });
          wroteCliConfig = invite.name;
        } else {
          writeMcpConfig(dest, { ...MCP_SERVER_ENTRY, env });
        }
        written.push(dest);
        excludeIfUntracked(root, dest);
      }
    } catch (err) {
      // The token is already minted. Losing the run here would leave it nowhere.
      failed.push({ name: invite.name, id: agent.data.id, why: err instanceof Error ? err.message : String(err) });
      continue;
    }
    connected.push({ name: invite.name, workerType: invite.workerType, targets: written });
    team.push({ name: invite.name, id: agent.data.id, token: agent.token });
    const where = written.length ? "" : chalk.yellow("  no config written");
    console.log(`  ${chalk.green("✓")} ${invite.name} ${chalk.dim(`(${invite.role}${invite.specialization ? `, ${invite.specialization}` : ""})`)}${where}`);
  }

  if (connected.length === 0) {
    console.error(chalk.red("\n  Nothing was connected."));
    process.exit(1);
  }

  if (failed.length) {
    console.log(chalk.red("\n  Created but not configured (revoke these if you do not re-run):"));
    for (const f of failed) console.log(chalk.red(`    ${f.name} (${f.id}): ${f.why}`));
  }

  if (skipped.length) {
    console.log(chalk.red("\n  Refused to write a token into a file git tracks:"));
    for (const s of skipped) console.log(chalk.red(`    ${s.name} -> ${s.target.replace(home, "~")}`));
    console.log(chalk.dim("    Untrack it (git rm --cached <file>) and run join again, or configure that agent by hand."));
  }

  const shook = await handshake(api, repoId, team);
  if (shook.attempted > 0) {
    const ok = shook.delivered === shook.attempted;
    const what = "solo" in shook ? "token authenticates" : `${shook.delivered}/${shook.attempted} agents exchanged a message`;
    console.log(`\n  ${ok ? chalk.green("✓") : chalk.yellow("!")} ${what}`);
    if (!ok) console.log(chalk.yellow("    The agent was created, but its token did not work. Check the dashboard."));
  }

  const wrote = [...new Set(connected.flatMap((c) => c.targets))];
  if (wrote.length === 0) {
    console.log(chalk.yellow("\n  Agents were created, but nothing was written to disk.\n"));
  } else {
    console.log(chalk.bold("\n  You're in.\n"));
  }
  console.log(`  repo      ${chalk.cyan(repoName)}`);
  console.log(`  agents    ${connected.map((c) => c.name).join(", ")}`);
  console.log(`  api       ${api}`);
  if (wrote.length) console.log(`  wrote     ${wrote.map((t) => t.replace(home, "~")).join("\n            ")}`);
  console.log(chalk.yellow("\n  Restart this session before using pitboss."));
  console.log(chalk.dim("  A running MCP client keeps the tool schema it got at initialize."));
  console.log(chalk.dim("\n  To add another agent, on this machine or any other:"));
  console.log(chalk.dim("    give it its own worktree, run pitboss join there,"));
  console.log(chalk.dim(`    and pick ${repoName} on the approval screen.`));
  console.log("");
}
