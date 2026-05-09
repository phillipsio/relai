import { describe, it, expect } from "vitest";
import { runReviewerAgentVerification } from "./verify-reviewer-agent.js";

describe("runReviewerAgentVerification", () => {
  it("returns exit 0 with reviewer name in stdout when approved", () => {
    const r = runReviewerAgentVerification({
      decision: "approve", reviewerId: "agent_rev1", decidedAt: new Date().toISOString(),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("agent_rev1");
    expect(r.stderr).toBe("");
    expect(r.timedOut).toBe(false);
  });

  it("returns exit 1 with reviewer + note in stderr when rejected", () => {
    const r = runReviewerAgentVerification({
      decision: "reject", reviewerId: "agent_rev2", decidedAt: new Date().toISOString(), note: "missing tests",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("agent_rev2");
    expect(r.stderr).toContain("missing tests");
  });
});
