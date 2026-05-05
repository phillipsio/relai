import { describe, it, expect } from "vitest";
import { runVerification } from "./verify.js";

describe("runVerification", () => {
  it("captures exit 0 from a passing command", async () => {
    const r = await runVerification("true");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("captures non-zero exit from a failing command", async () => {
    const r = await runVerification("false");
    expect(r.exitCode).toBe(1);
    expect(r.timedOut).toBe(false);
  });

  it("captures stdout and stderr", async () => {
    const r = await runVerification("echo hi && echo bye 1>&2");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hi");
    expect(r.stderr).toContain("bye");
  });

  it("completes within timeout when command is fast", async () => {
    const r = await runVerification("sleep 0.05 && true", undefined, 2000);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(40);
  });

  it("kills the command on timeout", async () => {
    const r = await runVerification("sleep 5", undefined, 50);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it("respects cwd", async () => {
    const r = await runVerification("pwd", "/tmp");
    expect(r.exitCode).toBe(0);
    // macOS resolves /tmp to /private/tmp; accept either.
    expect(r.stdout.trim()).toMatch(/\/tmp$|\/private\/tmp$/);
  });
});
