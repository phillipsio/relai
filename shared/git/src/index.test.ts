import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRepoUrl, repoNameFromUrl, checkRepoMatch } from "./index.js";

describe("normalizeRepoUrl", () => {
  it("canonicalizes https, ssh, and .git/slash variants to owner/repo", () => {
    const cases = [
      "https://github.com/phillipsio/relai",
      "https://github.com/phillipsio/relai.git",
      "https://github.com/phillipsio/relai/",
      "git@github.com:phillipsio/relai.git",
      "ssh://git@github.com/phillipsio/relai.git",
      "phillipsio/relai",
    ];
    for (const c of cases) expect(normalizeRepoUrl(c)).toBe("phillipsio/relai");
  });

  it("matches an SSH host-alias remote against the canonical https url", () => {
    // The exact false-positive this guard had to fix: a personal SSH host alias.
    expect(normalizeRepoUrl("git@github-personal:phillipsio/relai.git"))
      .toBe(normalizeRepoUrl("https://github.com/phillipsio/relai"));
  });

  it("is case-insensitive", () => {
    expect(normalizeRepoUrl("https://github.com/PhillipsIO/Relai.git")).toBe("phillipsio/relai");
  });

  it("keeps nested-group paths distinct (no last-two-segment collapse)", () => {
    // GitLab subgroups: dropping the top group would let two different repos
    // canonicalize equal and false-match. Keep the full path.
    expect(normalizeRepoUrl("https://gitlab.com/group/subgroup/repo")).toBe("group/subgroup/repo");
    expect(normalizeRepoUrl("https://gitlab.com/group/subgroup/repo"))
      .not.toBe(normalizeRepoUrl("https://gitlab.com/other/subgroup/repo"));
  });

  it("strips query and fragment", () => {
    expect(normalizeRepoUrl("https://github.com/phillipsio/relai?ref=main#x")).toBe("phillipsio/relai");
  });
});

describe("repoNameFromUrl", () => {
  it("returns the repo segment", () => {
    expect(repoNameFromUrl("git@github-personal:phillipsio/relai.git")).toBe("relai");
  });
});

describe("checkRepoMatch", () => {
  const saved = process.env.RELAI_SKIP_REPO_CHECK;
  afterEach(() => {
    if (saved === undefined) delete process.env.RELAI_SKIP_REPO_CHECK;
    else process.env.RELAI_SKIP_REPO_CHECK = saved;
  });

  it("no-ops when repoUrl is unset (repos.url is optional)", () => {
    expect(checkRepoMatch(process.cwd(), null).ok).toBe(true);
    expect(checkRepoMatch(process.cwd(), undefined).ok).toBe(true);
  });

  it("no-ops when RELAI_SKIP_REPO_CHECK is set (escape hatch)", () => {
    process.env.RELAI_SKIP_REPO_CHECK = "1";
    // A non-git tmp dir would normally fail; the escape hatch overrides it.
    const dir = mkdtempSync(join(tmpdir(), "relai-git-"));
    expect(checkRepoMatch(dir, "https://github.com/phillipsio/relai").ok).toBe(true);
  });

  it("fails with a fix hint when the working dir is not a git repo", () => {
    delete process.env.RELAI_SKIP_REPO_CHECK;
    const dir = mkdtempSync(join(tmpdir(), "relai-git-"));
    const res = checkRepoMatch(dir, "https://github.com/phillipsio/relai");
    expect(res.ok).toBe(false);
    expect(res.fix).toContain("git clone https://github.com/phillipsio/relai");
  });
});
