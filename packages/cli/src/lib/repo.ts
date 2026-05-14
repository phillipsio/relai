import { execFileSync } from "node:child_process";

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

export function normalizeRepoUrl(url: string): string {
  let u = url.trim();
  u = u.replace(/\.git$/i, "").replace(/\/+$/, "");

  // git@host:org/repo
  let m = u.match(/^git@([^:]+):(.+)$/);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();

  // scheme://[user@]host/path
  m = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();

  return u.toLowerCase();
}

export function repoNameFromUrl(url: string): string {
  const norm = normalizeRepoUrl(url);
  const last = norm.split("/").pop() ?? norm;
  return last;
}
