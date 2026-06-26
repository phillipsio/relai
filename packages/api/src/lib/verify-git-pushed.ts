import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VerificationResult } from "./verify.js";

const execFileAsync = promisify(execFile);

const GIT_PUSHED_TIMEOUT_MS = 10_000;

// `git ls-remote --exit-code` exit codes: 2 means "ref not found" — a clean,
// authoritative "not pushed" (the remote answered; the branch just isn't
// there). Anything else (network failure, auth failure, host unreachable,
// our own timeout, git missing) is an INFRA failure, not a verdict on the
// branch, and must not be reported as "not pushed" — see retryable below.
const GIT_NO_MATCHING_REF_EXIT = 2;

// `verifyPath` is free-text, not validated against git's own ref-name rules,
// and `git ls-remote` matches its <pattern> argument with fnmatch globbing.
// A `branch` value of e.g. "*" would make refs/heads/* match ANY branch on
// the remote and falsely report "pushed". Reject glob metacharacters before
// they ever reach `git` — a real branch name can't contain them anyway (git
// itself disallows `* ? [ \` in ref names), so this only ever rejects
// malicious/garbage input, never a legitimate branch.
const GLOB_METACHARS = /[*?[\]\\]/;

// repoUrl's schema accepts userinfo (https://user:pass@host/...). git can
// echo the full remote URL back in its own error/auth messages, and that
// text gets persisted to verification_log and fanned out over events — scrub
// credentials before they ever reach either.
const URL_USERINFO = /:\/\/[^/\s@]+@/g;
function scrubCredentials(text: string): string {
  return text.replace(URL_USERINFO, "://***@");
}

/**
 * Structured `git_pushed` verifier. Checks whether `branch` exists on
 * `remote` (the repo's `repos.repoUrl`, queried independently of any local
 * checkout) via `git ls-remote --exit-code --heads <remote> refs/heads/<branch>`
 * (argv array, no shell interpolation). Falls back to `git -C <cwd> ls-remote
 * origin ...` when no `remote` URL is available — that mode only works when
 * the API host itself has a checkout at `cwd`, which is the degenerate
 * single-host case, not the distributed deployment this kind targets.
 * Orchestrator-gated at the route layer (like `shell`) since it runs `git`
 * against an operator-supplied `cwd`/remote.
 */
export async function runGitPushedVerification(
  branch: string,
  remote: string | null | undefined,
  cwd?: string | null,
): Promise<VerificationResult> {
  const start = Date.now();

  if (GLOB_METACHARS.test(branch)) {
    return {
      exitCode:   GIT_NO_MATCHING_REF_EXIT,
      stdout:     "",
      stderr:     `git_pushed: branch name "${branch}" contains glob metacharacters, not a valid git ref — rejected without querying the remote`,
      durationMs: Date.now() - start,
      timedOut:   false,
      retryable:  false,
    };
  }

  const args = remote
    ? ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`]
    : ["-C", cwd ?? process.cwd(), "ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`];

  // GIT_ALLOW_PROTOCOL is defense-in-depth on the `remote` (repoUrl) path
  // only — repoUrl is API-supplied (already restricted to https/ssh at that
  // layer) so this stops git from ever dialing file:///ext:: regardless. The
  // cwd-fallback path uses the operator's own pre-configured local `origin`
  // (covered by git_pushed's orchestrator-authorship gate, not this), and
  // commonly IS a local file-path remote in single-host setups — don't
  // restrict its protocol or the legitimate fallback mode breaks.
  const env = remote
    ? { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:ssh" }
    : { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  try {
    // --exit-code guarantees exit 0 only on a match, so success here is
    // unconditionally "pushed" — there is no stdout-empty-but-exit-0 case to
    // branch on.
    const { stdout, stderr } = await execFileAsync("git", args, {
      timeout: GIT_PUSHED_TIMEOUT_MS,
      env,
    });
    return {
      exitCode:   0,
      stdout:     scrubCredentials(stdout),
      stderr:     scrubCredentials(stderr),
      durationMs: Date.now() - start,
      timedOut:   false,
      retryable:  false,
    };
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
    const stderr = scrubCredentials(e.stderr ?? e.message ?? String(err));
    const stdout = scrubCredentials(e.stdout ?? "");

    // Definitive "not found on remote" — git itself answered.
    if (e.code === GIT_NO_MATCHING_REF_EXIT) {
      return {
        exitCode:   GIT_NO_MATCHING_REF_EXIT,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut:   false,
        retryable:  false,
      };
    }

    // Everything else (network/auth/host-unreachable/timeout/git-missing) is
    // inconclusive — don't assert "not pushed".
    return {
      exitCode:   typeof e.code === "number" ? e.code : null,
      stdout,
      stderr,
      durationMs: Date.now() - start,
      timedOut:   e.killed === true,
      retryable:  true,
    };
  }
}
