import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardCandidates, guardFailureMessage, requirePositiveMatch, assertRepoMatch, type GuardFailure } from "./repo-guard.js";

const REPO_URL = "https://github.com/phillipsio/relai";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "relai-guard-"));
}

function gitRepo(originUrl?: string): string {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  if (originUrl) execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
  return dir;
}

const never = async () => {
  throw new Error("should not have been called");
};

const fail = (dir: string, source: GuardFailure["candidate"]["source"]): GuardFailure => ({
  candidate: { dir, source },
  reason: `Not a git repo: ${dir}.`,
  fix: "git clone https://example.com/r && cd r",
});

describe("guardCandidates (fallback candidates only — cwd is not among them)", () => {
  it("uses RELAI_REPO_PATH alone when it is set", async () => {
    const res = await guardCandidates(never, { RELAI_REPO_PATH: "/explicit" });
    expect(res).toEqual([{ dir: "/explicit", source: "RELAI_REPO_PATH" }]);
  });

  it("falls back to the registered repoPath when no override is set", async () => {
    const res = await guardCandidates(async () => "/registered", {});
    expect(res).toEqual([{ dir: "/registered", source: "registered repoPath" }]);
  });

  it("returns no candidates when there is no override and no registered repoPath", async () => {
    const res = await guardCandidates(async () => null, {});
    expect(res).toEqual([]);
  });

  it("returns no candidates when the API call fails, rather than hard-failing", async () => {
    const res = await guardCandidates(async () => { throw new Error("ECONNREFUSED"); }, {});
    expect(res).toEqual([]);
  });

  it("treats an empty or whitespace-only override as unset", async () => {
    for (const value of ["", "   "]) {
      const res = await guardCandidates(async () => "/registered", { RELAI_REPO_PATH: value });
      expect(res).toEqual([{ dir: "/registered", source: "registered repoPath" }]);
    }
  });

  it("treats an empty or whitespace-only registered repoPath as unset", async () => {
    for (const value of ["", "   "]) {
      const res = await guardCandidates(async () => value, {});
      expect(res).toEqual([]);
    }
  });

  it("trims a padded override", async () => {
    const res = await guardCandidates(never, { RELAI_REPO_PATH: "  /explicit  " });
    expect(res[0].dir).toBe("/explicit");
  });
});

describe("requirePositiveMatch", () => {
  it("fails on a directory that is not a git repo at all", () => {
    const dir = tempDir();
    try {
      const res = requirePositiveMatch(dir, REPO_URL);
      expect(res.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on a real git repo with no origin remote — the bare `git init` bypass this closes", () => {
    // checkRepoMatch's generic no-origin no-op is a safe pass for cwd, since a
    // developer's real clone might just not have a remote configured yet — but
    // accepting it here would let RELAI_REPO_PATH point at ANY empty git repo
    // and satisfy the guard unconditionally.
    const dir = gitRepo();
    try {
      const res = requirePositiveMatch(dir, REPO_URL);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain("no origin remote");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on a git repo whose origin doesn't match", () => {
    const dir = gitRepo("https://github.com/someone-else/other-repo");
    try {
      const res = requirePositiveMatch(dir, REPO_URL);
      expect(res.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes on a git repo with the matching origin", () => {
    const dir = gitRepo(REPO_URL);
    try {
      expect(requirePositiveMatch(dir, REPO_URL)).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assertRepoMatch — the full guard, cwd-first", () => {
  it("passes when cwd itself is a matching clone, without ever calling fetchRepoPath", async () => {
    const dir = gitRepo(REPO_URL);
    try {
      const res = await assertRepoMatch(dir, REPO_URL, never);
      expect(res).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSION: a cwd that is a real repo with the WRONG origin fails even when a fallback candidate would have matched", async () => {
    // This is the exact hole the review found: the guard used to try
    // candidates in order and return on the first success, so a hostile or
    // simply-wrong cwd was rescued by an unrelated registered repoPath. cwd's
    // contradiction must be authoritative.
    const hostileCwd = gitRepo("https://github.com/evil/other.git");
    const validClone = gitRepo(REPO_URL);
    try {
      const res = await assertRepoMatch(hostileCwd, REPO_URL, async () => validClone);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toContain("evil/other");
    } finally {
      rmSync(hostileCwd, { recursive: true, force: true });
      rmSync(validClone, { recursive: true, force: true });
    }
  });

  it("falls through to RELAI_REPO_PATH when cwd is not a git repo at all (the Cursor case)", async () => {
    const cwd = tempDir();
    const clone = gitRepo(REPO_URL);
    try {
      const res = await assertRepoMatch(cwd, REPO_URL, never, { RELAI_REPO_PATH: clone });
      expect(res).toEqual({ ok: true, via: "RELAI_REPO_PATH" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("falls through to the registered repoPath when cwd is not a git repo and no override is set", async () => {
    const cwd = tempDir();
    const clone = gitRepo(REPO_URL);
    try {
      const res = await assertRepoMatch(cwd, REPO_URL, async () => clone, {});
      expect(res).toEqual({ ok: true, via: "registered repoPath" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("REGRESSION: RELAI_REPO_PATH pointed at a bare `git init` (no origin) does not bypass the guard", async () => {
    const cwd = tempDir();
    const bareRepo = gitRepo(); // git init, no origin — the bypass the review found
    try {
      const res = await assertRepoMatch(cwd, REPO_URL, never, { RELAI_REPO_PATH: bareRepo });
      expect(res.ok).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(bareRepo, { recursive: true, force: true });
    }
  });

  it("fails and names cwd itself when cwd is not a git repo and no fallback candidate matches", async () => {
    const cwd = tempDir();
    try {
      const res = await assertRepoMatch(cwd, REPO_URL, async () => null, {});
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toContain(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("guardFailureMessage", () => {
  it("lists every directory tried and why each was rejected", () => {
    const msg = guardFailureMessage([
      fail("/moved/away", "registered repoPath"),
      fail("/Users/jim", "process.cwd()"),
    ]);
    expect(msg).toContain("/moved/away  (from registered repoPath)");
    expect(msg).toContain("/Users/jim  (from process.cwd())");
    expect(msg).toContain("Not a git repo: /moved/away.");
    expect(msg).toContain("Not a git repo: /Users/jim.");
  });

  it("names RELAI_REPO_PATH when the paths were ambient rather than chosen", () => {
    const msg = guardFailureMessage([fail("/Users/jim", "process.cwd()")]);
    expect(msg).toContain("RELAI_REPO_PATH");
    expect(msg).toContain("repoPath");
  });

  it("does not suggest the override when it was already set", () => {
    const msg = guardFailureMessage([fail("/explicit", "RELAI_REPO_PATH")]);
    expect(msg).not.toContain("If this client cannot choose");
  });

  it("still ends with the actionable clone command", () => {
    const msg = guardFailureMessage([fail("/Users/jim", "process.cwd()")]);
    expect(msg.trimEnd().endsWith("git clone https://example.com/r && cd r")).toBe(true);
  });
});
