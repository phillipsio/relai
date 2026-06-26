import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitPushedVerification } from "./verify-git-pushed.js";

const git = promisify(execFile);

let bareDir: string;
let workDir: string;

beforeAll(async () => {
  bareDir = await mkdtemp(join(tmpdir(), "relai-gpv-bare-"));
  workDir = await mkdtemp(join(tmpdir(), "relai-gpv-work-"));

  await git("git", ["init", "--bare", "-q", bareDir]);

  await git("git", ["init", "-q", workDir]);
  await git("git", ["config", "user.email", "test@example.com"], { cwd: workDir });
  await git("git", ["config", "user.name", "Test"], { cwd: workDir });
  await git("git", ["remote", "add", "origin", bareDir], { cwd: workDir });
  await writeFile(join(workDir, "f.txt"), "x");
  await git("git", ["add", "."], { cwd: workDir });
  await git("git", ["commit", "-q", "-m", "init"], { cwd: workDir });

  // pushed-branch: lands on the bare "remote". unpushed-branch: local only.
  await git("git", ["checkout", "-q", "-b", "pushed-branch"], { cwd: workDir });
  await git("git", ["push", "-q", "origin", "pushed-branch"], { cwd: workDir });
  await git("git", ["checkout", "-q", "-b", "unpushed-branch"], { cwd: workDir });
});

afterAll(async () => {
  await rm(bareDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

// The `remote` (repoUrl) path runs with GIT_ALLOW_PROTOCOL=https:ssh as an
// SSRF guard, so it can't be exercised end-to-end against a local fixture
// without a real https/ssh endpoint. The branch-found/not-found/non-repo
// logic is identical code regardless of which path supplies the args, so
// that logic is exercised via the (protocol-unrestricted) cwd-fallback below
// instead; this block only tests behavior specific to the `remote` path.
describe("runGitPushedVerification — resolved via repo URL (distributed-host path)", () => {
  it("rejects a glob-metacharacter branch name without querying the remote", async () => {
    // verifyPath is free text, not a validated git ref. "*" would otherwise
    // make `ls-remote`'s pattern match ANY branch and falsely report
    // "pushed" even though no specific branch was actually checked. Rejected
    // before any git process is spawned, so it doesn't matter that `remote`
    // here isn't a real https/ssh URL.
    const r = await runGitPushedVerification("*", bareDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.retryable).toBe(false);
    expect(r.stderr).toContain("glob");
  });

  it("blocks a non-https/ssh remote via GIT_ALLOW_PROTOCOL (SSRF guard)", async () => {
    // repoUrl is schema-validated to https/ssh at the API layer, but this is
    // the defense-in-depth check: even a bare local path slipped through as
    // `remote` must not let git dial a file:// (or other) transport.
    const r = await runGitPushedVerification("pushed-branch", bareDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.exitCode).not.toBe(2);
    expect(r.retryable).toBe(true);
  });

  it("marks an unreachable remote as retryable, not a clean miss", async () => {
    const r = await runGitPushedVerification("pushed-branch", "https://127.0.0.1.invalid/no-such-repo.git");
    expect(r.exitCode).not.toBe(0);
    expect(r.exitCode).not.toBe(2);
    expect(r.retryable).toBe(true);
  }, 15_000);

  it("scrubs userinfo credentials out of stderr (repoUrl schema accepts user:pass@)", async () => {
    const r = await runGitPushedVerification("pushed-branch", "https://itsasecret:supersecret@127.0.0.1.invalid/x.git");
    expect(r.stderr).not.toContain("itsasecret");
    expect(r.stderr).not.toContain("supersecret");
  }, 15_000);
});

describe("runGitPushedVerification — local-checkout fallback (no repoUrl)", () => {
  it("exits 0, not retryable, when the branch exists on origin", async () => {
    const r = await runGitPushedVerification("pushed-branch", null, workDir);
    expect(r.exitCode).toBe(0);
    expect(r.retryable).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it("exits 2, not retryable, when the branch was never pushed (clean negative)", async () => {
    const r = await runGitPushedVerification("unpushed-branch", null, workDir);
    expect(r.exitCode).toBe(2);
    expect(r.retryable).toBe(false);
  });

  it("rejects a glob-metacharacter branch name without querying the remote", async () => {
    const r = await runGitPushedVerification("*", null, workDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.retryable).toBe(false);
    expect(r.stderr).toContain("glob");
  });

  it("marks a not-a-repo cwd as retryable, not a clean miss", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "relai-gpv-norepo-"));
    const r = await runGitPushedVerification("pushed-branch", null, notARepo);
    expect(r.exitCode).not.toBe(2);
    expect(r.retryable).toBe(true);
    await rm(notARepo, { recursive: true, force: true });
  });
});
