import chalk from "chalk";
import ora from "ora";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { confirm } from "@inquirer/prompts";
import { requireConfig, writeConfig, configPath } from "../config.js";
import { CliApiClient } from "../api.js";
import { allRuntimeTargets, holdsRelaiToken } from "../lib/runtimes.js";

function gitRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || cwd;
  } catch {
    return cwd;
  }
}

/**
 * Names the configs still holding the old token. One agent's token lives in
 * several files: `relai join` writes it into whichever MCP configs its host
 * reads, and the invite snippet tells people to paste it into others by hand.
 *
 * This reports rather than rewrites, deliberately. Rewriting them safely means
 * handling git-tracked files, symlinks into dotfiles repos, JSONC, the nested
 * project scopes in ~/.claude.json, and replacing atomically instead of
 * truncating in place. A rotate that gets some of those wrong is worse than one
 * that hands the operator an accurate list.
 */
function configsHoldingToken(oldToken: string): string[] {
  const repo = gitRoot(process.cwd());
  const found: string[] = [];

  for (const target of allRuntimeTargets({ home: homedir(), repo })) {
    if (target === configPath() || !existsSync(target)) continue;
    try {
      if (holdsRelaiToken(JSON.parse(readFileSync(target, "utf-8")), oldToken)) found.push(target);
    } catch {
      // Unparseable, or a JSONC config that JSON.parse rejects. Report it
      // anyway: "I could not read this one" is more use than silence, and the
      // cost of a false positive is the operator opening a file needlessly.
      found.push(`${target} ${chalk.dim("(unreadable, check by hand)")}`);
    }
  }
  return found;
}

export async function tokenRotateCommand() {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const stale = configsHoldingToken(config.apiToken);

  const s = ora("Issuing new token…").start();
  let token: string;
  let tokenId: string;
  let revoked: string[];
  try {
    ({ token, tokenId, revoked } = await client.rotateToken(config.agentId));
    s.succeed(chalk.green("New token issued"));
  } catch (err) {
    s.fail(chalk.red("Rotate failed"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }

  // Printed before anything is written. Past this line the old token is already
  // revoked, so a failure that swallowed the plaintext would lock the agent out:
  // rotating again needs a working token, and no route lists them.
  console.log(`
${chalk.bold("New token")} ${chalk.dim("(save this now, it is not shown again)")}
  ${token}
${chalk.dim("token id:")} ${tokenId}
`);

  // Concurrent rotations each return 201, and every one after the first hands
  // back a credential its successor already revoked. Only a 401 proves that
  // happened; an unreachable API proves nothing and must not abort the writes.
  const verdict = await new CliApiClient({ ...config, apiToken: token }).checkToken();
  if (verdict === "rejected") {
    console.error(chalk.red("The new token was refused. Config left unchanged, keep using the old one."));
    console.error(chalk.dim("Another rotation ran at the same time and revoked it. Run rotate again."));
    process.exit(1);
  }
  if (verdict === "unknown") {
    console.log(chalk.yellow("Could not reach the API to verify the new token. Saving it anyway."));
  }

  try {
    writeConfig({ ...config, apiToken: token });
    console.log(`${chalk.green("✓")} ${configPath()}`);
  } catch (err) {
    console.error(chalk.red(`Could not write ${configPath()}: ${err instanceof Error ? err.message : String(err)}`));
    console.error(chalk.dim("Put the token above into that file by hand."));
  }

  if (stale.length) {
    console.log(`
${chalk.yellow("These files still hold the old token. Update them by hand:")}
${stale.map((t) => `  ${t}`).join("\n")}
`);
  }

  if (revoked.length) {
    console.log(`${chalk.dim("Revoked:")} ${revoked.join(", ")}`);
    console.log("Any client still holding one of those gets 401 on its next call.\n");
  }
}

export async function tokenRevokeCommand(tokenId: string) {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const ok = await confirm({
    message: `Revoke token ${tokenId}? This cannot be undone.`,
    default: false,
  });
  if (!ok) return;

  const s = ora("Revoking…").start();
  try {
    await client.revokeToken(tokenId);
    s.succeed(chalk.green(`Revoked ${tokenId}`));
  } catch (err) {
    s.fail(chalk.red("Revoke failed"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}

export async function tokenListCommand() {
  const config = requireConfig();
  const client = new CliApiClient(config);

  let rows;
  try {
    rows = await client.listTokens(config.agentId);
  } catch (err) {
    console.error(chalk.red("Could not list tokens"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }

  const live = rows.filter((r) => !r.revokedAt);
  const day = (v: string | null) => (v ? v.slice(0, 10) : chalk.dim("never"));

  for (const r of rows) {
    const state = r.revokedAt ? chalk.dim(`revoked ${day(r.revokedAt)}`) : chalk.green("live");
    const mine  = r.current ? chalk.cyan("  ← this one") : "";
    console.log(`${r.id}  ${state}  ${chalk.dim("created")} ${day(r.createdAt)}  ${chalk.dim("used")} ${day(r.lastUsedAt)}${mine}`);
  }

  console.log(`\n${live.length} live, ${rows.length - live.length} revoked.`);
  if (live.length > 1) {
    console.log(chalk.yellow(`${live.length} live tokens: every one of them authenticates. 'relai token rotate' collapses them to one.`));
  }
  const dormant = live.filter((r) => !r.lastUsedAt && !r.current);
  if (dormant.length) {
    console.log(chalk.yellow(`${dormant.length} live but never used. Nothing alerts on a credential nobody uses.`));
  }
}
