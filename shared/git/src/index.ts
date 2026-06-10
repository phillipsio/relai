import { execFileSync } from "node:child_process";

// Shared git/repo helpers. Used by every surface that attaches an agent to a
// repo (CLI login, MCP agent-mode, the workers) so the "you must be in a clone
// of this repo" guard is enforced by ONE implementation, not copies that drift.

export function getGitRoot(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function getOriginUrl(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// Canonicalize a git remote URL to a host-agnostic repo path. We strip the
// scheme/userinfo/host so that an SSH host-alias remote
// (git@github-personal:phillipsio/relai.git) matches the canonical https url
// (https://github.com/phillipsio/relai) — the alias host is exactly what made a
// strict string compare give false mismatches. We keep the FULL remaining path
// (not just owner/repo) so nested groups (e.g. GitLab gitlab.com/group/sub/repo)
// stay distinct and don't collide on the last two segments. Handles https/scheme
// URLs, scp-like ssh (git@host:owner/repo), query/fragment, trailing .git and
// slashes, and bare owner/repo paths. (A single operator won't host the same
// path on two different forges, so dropping the host is safe here.)
export function normalizeRepoUrl(url: string): string {
  let u = url.trim().replace(/\.git$/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");

  let path: string;
  const scheme = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i); // scheme://[user@]host/PATH
  if (scheme) {
    path = scheme[1];
  } else {
    const scp = u.match(/^(?:[^@]+@)?[^/:]+:(.+)$/); // [user@]host:PATH (scp-like / ssh alias)
    path = scp ? scp[1] : u; // else treat as a bare path
  }

  return path.split("/").filter(Boolean).join("/").toLowerCase();
}

export function repoNameFromUrl(url: string): string {
  const norm = normalizeRepoUrl(url);
  return norm.split("/").pop() ?? norm;
}

export interface RepoMatch {
  ok: boolean;
  reason?: string;
  fix?: string;
}

// Is `workingDir` a clone whose origin matches `repoUrl`? This is the guard
// every agent connect surface runs. It NO-OPS (ok) when:
//   - repoUrl is unset — repos.url is optional; nothing to enforce against, OR
//   - RELAI_SKIP_REPO_CHECK is set — the deliberate operator escape hatch, OR
//   - the working tree has a git root but no `origin` remote — can't compare.
// It only hard-fails on a concrete contradiction: not a git repo at all, or an
// origin that canonicalizes differently from repoUrl.
export function checkRepoMatch(workingDir: string, repoUrl: string | null | undefined): RepoMatch {
  if (!repoUrl) return { ok: true };
  if (process.env.RELAI_SKIP_REPO_CHECK) return { ok: true };

  const root = getGitRoot(workingDir);
  if (!root) {
    return {
      ok: false,
      reason: `Not in a git repo (cwd: ${workingDir}).`,
      fix: `git clone ${repoUrl} && cd ${repoNameFromUrl(repoUrl)}`,
    };
  }

  const origin = getOriginUrl(root);
  if (origin && normalizeRepoUrl(origin) !== normalizeRepoUrl(repoUrl)) {
    return {
      ok: false,
      reason: `Working tree ${root} has origin ${origin}, but this agent's repo is ${repoUrl}.`,
      fix: `cd into a clone of ${repoUrl} (or set RELAI_SKIP_REPO_CHECK=1 to override).`,
    };
  }

  return { ok: true };
}

// Fetch a repo's canonical url from the API for the guard. Shared by the workers
// (the MCP server uses its own ApiClient) so the fetch-and-skip policy lives in
// one place. Returns null — which makes checkRepoMatch a no-op — when the API is
// unreachable (transient: don't block startup) or returns non-OK (logged, since
// a 401/404 silently disabling the guard would otherwise be invisible).
export async function fetchRepoUrl(
  apiUrl: string,
  repoId: string,
  bearer: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl}/repos/${repoId}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) {
      console.warn(`[relai] repo guard skipped — GET /repos/${repoId} returned ${res.status}`);
      return null;
    }
    return ((await res.json()) as { data?: { repoUrl?: string | null } })?.data?.repoUrl ?? null;
  } catch {
    return null; // unreachable — don't hard-block startup on a network blip
  }
}
