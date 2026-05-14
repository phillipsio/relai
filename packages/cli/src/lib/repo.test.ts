import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitRoot, getOriginUrl, normalizeRepoUrl, repoNameFromUrl } from "./repo.js";

describe("normalizeRepoUrl", () => {
  it("normalizes ssh-style git@host:org/repo.git", () => {
    expect(normalizeRepoUrl("git@github.com:phillipsio/relai.git")).toBe("github.com/phillipsio/relai");
  });
  it("normalizes https URL with .git", () => {
    expect(normalizeRepoUrl("https://github.com/phillipsio/relai.git")).toBe("github.com/phillipsio/relai");
  });
  it("normalizes https URL without .git, trailing slash", () => {
    expect(normalizeRepoUrl("https://github.com/phillipsio/relai/")).toBe("github.com/phillipsio/relai");
  });
  it("normalizes ssh://git@host/path", () => {
    expect(normalizeRepoUrl("ssh://git@github.com/phillipsio/relai.git")).toBe("github.com/phillipsio/relai");
  });
  it("is case-insensitive", () => {
    expect(normalizeRepoUrl("https://GitHub.com/PhillipsIO/Relai.git")).toBe("github.com/phillipsio/relai");
  });
  it("considers ssh and https equivalent", () => {
    expect(normalizeRepoUrl("git@github.com:phillipsio/relai.git"))
      .toBe(normalizeRepoUrl("https://github.com/phillipsio/relai"));
  });
});

describe("repoNameFromUrl", () => {
  it("returns the last segment", () => {
    expect(repoNameFromUrl("git@github.com:phillipsio/relai.git")).toBe("relai");
    expect(repoNameFromUrl("https://github.com/phillipsio/relai")).toBe("relai");
  });
});

describe("getGitRoot / getOriginUrl", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relai-repo-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when not in a git repo", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(getGitRoot(sub)).toBe(null);
    expect(getOriginUrl(sub)).toBe(null);
  });

  it("returns git root and origin url when present", () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:phillipsio/relai.git"], { cwd: dir });
    const sub = join(dir, "nested");
    mkdirSync(sub);
    const root = getGitRoot(sub);
    expect(root).not.toBe(null);
    expect(getOriginUrl(root!)).toBe("git@github.com:phillipsio/relai.git");
  });
});
