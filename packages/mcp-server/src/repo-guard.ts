import { getGitRoot, getOriginUrl, normalizeRepoUrl, repoNameFromUrl, checkRepoMatch } from "@getrelai/git";

// cwd is authoritative when it's a real repo (pass or fail); RELAI_REPO_PATH
// and the registered repoPath are only consulted when cwd is inconclusive, and each requires a positive origin match.

export type GuardSource = "process.cwd()" | "RELAI_REPO_PATH" | "registered repoPath";

export interface GuardCandidate {
  dir: string;
  source: GuardSource;
}

export interface GuardFailure {
  candidate: GuardCandidate;
  reason: string;
  fix: string;
}

export type GuardResult = { ok: true; via?: GuardSource } | { ok: false; message: string };

// Fallback candidates only — cwd is handled by the caller, before these are
// ever considered.
export async function guardCandidates(
  fetchRepoPath: () => Promise<string | null | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GuardCandidate[]> {
  const override = env.RELAI_REPO_PATH?.trim();
  if (override) return [{ dir: override, source: "RELAI_REPO_PATH" }];

  try {
    const registered = (await fetchRepoPath())?.trim();
    if (registered) return [{ dir: registered, source: "registered repoPath" }];
  } catch {
    // Unreachable API must not turn a soft check into a startup crash.
  }
  return [];
}

// Stricter than checkRepoMatch: a fallback candidate must have an actual
// origin that matches, since "couldn't tell" is only a safe pass for cwd.
export function requirePositiveMatch(dir: string, repoUrl: string): { ok: true } | { ok: false; reason: string; fix: string } {
  const root = getGitRoot(dir);
  if (!root) {
    return { ok: false, reason: `Not a git repo: ${dir}.`, fix: `git clone ${repoUrl} && cd ${repoNameFromUrl(repoUrl)}` };
  }
  const origin = getOriginUrl(root);
  if (!origin) {
    return {
      ok: false,
      reason: `${root} has no origin remote to verify against ${repoUrl}.`,
      fix: `cd into a clone of ${repoUrl}, or set RELAI_SKIP_REPO_CHECK=1 to override.`,
    };
  }
  if (normalizeRepoUrl(origin) !== normalizeRepoUrl(repoUrl)) {
    return {
      ok: false,
      reason: `Working tree ${root} has origin ${origin}, but this agent's repo is ${repoUrl}.`,
      fix: `cd into a clone of ${repoUrl} (or set RELAI_SKIP_REPO_CHECK=1 to override).`,
    };
  }
  return { ok: true };
}

// The full guard, cwd-first. Pure and injectable so it's testable without
// touching process.exit or module-level state — index.ts is a thin wrapper.
export async function assertRepoMatch(
  cwd: string,
  repoUrl: string,
  fetchRepoPath: () => Promise<string | null | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GuardResult> {
  const cwdRoot = getGitRoot(cwd);
  if (cwdRoot) {
    // cwd's verdict is final — never rescued by another candidate.
    const check = checkRepoMatch(cwd, repoUrl);
    if (check.ok) return { ok: true };
    return { ok: false, message: `[relai-mcp] ${check.reason}\n  ${check.fix}` };
  }

  // cwd is inconclusive (not a git repo at all) — the actual Cursor case.
  const candidates = await guardCandidates(fetchRepoPath, env);
  const failures: GuardFailure[] = [
    { candidate: { dir: cwd, source: "process.cwd()" }, reason: `Not a git repo: ${cwd}.`, fix: `git clone ${repoUrl} && cd ${repoNameFromUrl(repoUrl)}` },
  ];
  for (const candidate of candidates) {
    const check = requirePositiveMatch(candidate.dir, repoUrl);
    if (check.ok) return { ok: true, via: candidate.source };
    failures.push({ candidate, reason: check.reason, fix: check.fix });
  }
  return { ok: false, message: guardFailureMessage(failures) };
}

// Shows every place tried and why; names the override only when the path
// was ambient (unset) rather than a deliberate, already-wrong choice.
export function guardFailureMessage(failures: GuardFailure[]): string {
  const lines = ["[relai-mcp] could not find a working tree for this agent's repo:"];

  for (const { candidate, reason } of failures) {
    lines.push(`  ${candidate.dir}  (from ${candidate.source})`, `    ${reason}`);
  }

  if (!failures.some((f) => f.candidate.source === "RELAI_REPO_PATH")) {
    lines.push(
      "  If this client cannot choose a working directory (Cursor cannot), set",
      "  RELAI_REPO_PATH to your clone, or register the agent's repoPath.",
    );
  }

  lines.push(`  ${failures[failures.length - 1].fix}`);
  return lines.join("\n");
}
