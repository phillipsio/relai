import { describe, it, expect } from "vitest";
import { buildPrompt } from "./prompt.js";
import type { ClaudeWorkerConfig } from "./config.js";

function config(overrides: Partial<ClaudeWorkerConfig> = {}): ClaudeWorkerConfig {
  return {
    agentId: "agent_test",
    projectId: "proj_test",
    apiUrl: "http://localhost:3010",
    apiSecret: "secret",
    repoPath: "/repo",
    pollIntervalMs: 15000,
    maxTaskRounds: 5,
    model: "claude-sonnet-4-6",
    specialization: "writer",
    claudeBin: "claude",
    ...overrides,
  };
}

describe("buildPrompt", () => {
  it("includes agent ID and repo path in base loop", () => {
    const prompt = buildPrompt(config({ agentId: "agent_abc", repoPath: "/workspace/myrepo" }));
    expect(prompt).toContain("agent_abc");
    expect(prompt).toContain("/workspace/myrepo");
  });

  it("uses mcp__relai__ prefixed tool names throughout", () => {
    const prompt = buildPrompt(config());
    expect(prompt).toContain("mcp__relai__get_unread_messages");
    expect(prompt).toContain("mcp__relai__get_my_tasks");
    expect(prompt).toContain("mcp__relai__update_task_status");
    expect(prompt).toContain("mcp__relai__send_message");
    expect(prompt).toContain("mcp__relai__mark_thread_read");
    expect(prompt).toContain("mcp__relai__create_thread");
  });

  it("always includes the task chain rules block", () => {
    for (const spec of ["writer", "reviewer", "architect", "tester", "devops"] as const) {
      const prompt = buildPrompt(config({ specialization: spec }));
      expect(prompt, `${spec}: missing task chain block`).toContain("Task chain rules");
      expect(prompt, `${spec}: missing roundNumber`).toContain("roundNumber");
      expect(prompt, `${spec}: missing parentTaskId`).toContain("parentTaskId");
    }
  });

  it("always includes the handoff discipline block", () => {
    for (const spec of ["writer", "reviewer", "architect", "tester", "devops"] as const) {
      const prompt = buildPrompt(config({ specialization: spec }));
      expect(prompt, `${spec}: missing handoff block`).toContain("Handoff discipline");
    }
  });

  it("embeds maxTaskRounds in the escalation guard", () => {
    const prompt = buildPrompt(config({ maxTaskRounds: 3 }));
    expect(prompt).toContain("3");
  });

  describe("writer specialization", () => {
    it("includes writer role header", () => {
      const prompt = buildPrompt(config({ specialization: "writer" }));
      expect(prompt).toContain("Writer (implementer)");
    });

    it("instructs creating a branch and opening a PR", () => {
      const prompt = buildPrompt(config({ specialization: "writer" }));
      expect(prompt).toContain("branchName");
      expect(prompt).toContain("gh pr create");
    });

    it("routes completed work to reviewer", () => {
      const prompt = buildPrompt(config({ specialization: "writer" }));
      expect(prompt).toContain('"reviewer"');
    });

    it("describes the fix-cycle for findings", () => {
      const prompt = buildPrompt(config({ specialization: "writer" }));
      expect(prompt).toContain("findings");
      expect(prompt).toContain("Fix-cycle");
    });
  });

  describe("reviewer specialization", () => {
    it("includes reviewer role header", () => {
      const prompt = buildPrompt(config({ specialization: "reviewer" }));
      expect(prompt).toContain("Intake / Reviewer");
    });

    it("has an explicit CHECK FIRST mode decision gate", () => {
      const prompt = buildPrompt(config({ specialization: "reviewer" }));
      expect(prompt).toContain("CHECK FIRST");
      expect(prompt).toContain("INTAKE MODE");
      expect(prompt).toContain("REVIEW MODE");
    });

    it("intake mode: prescribes exactly two tool calls", () => {
      const prompt = buildPrompt(config({ specialization: "reviewer" }));
      expect(prompt).toContain("exactly these two calls");
      expect(prompt).toContain("Two calls. Stop here.");
    });

    it("intake mode: forbids reading the repo", () => {
      const prompt = buildPrompt(config({ specialization: "reviewer" }));
      expect(prompt).toContain("Do NOT use file tools");
    });

    it("prohibits writing source code", () => {
      const prompt = buildPrompt(config({ specialization: "reviewer" }));
      expect(prompt).toContain("do NOT write or modify source code");
    });

    it("defines the findings schema", () => {
      const prompt = buildPrompt(config({ specialization: "reviewer" }));
      expect(prompt).toContain('"blocking"');
      expect(prompt).toContain('"warning"');
      expect(prompt).toContain('"info"');
    });

    it("review mode: routes blocking findings back to writer", () => {
      const prompt = buildPrompt(config({ specialization: "reviewer" }));
      expect(prompt).toContain('"writer"');
    });
  });

  describe("architect specialization", () => {
    it("includes architect role header", () => {
      const prompt = buildPrompt(config({ specialization: "architect" }));
      expect(prompt).toContain("Architect");
    });

    it("delegates implementation to writer", () => {
      const prompt = buildPrompt(config({ specialization: "architect" }));
      expect(prompt).toContain('"writer"');
    });
  });

  describe("tester specialization", () => {
    it("includes tester role header", () => {
      const prompt = buildPrompt(config({ specialization: "tester" }));
      expect(prompt).toContain("Tester");
    });

    it("routes passing tests to reviewer", () => {
      const prompt = buildPrompt(config({ specialization: "tester" }));
      expect(prompt).toContain("mcp__relai__create_task` → \"reviewer\"");
    });

    it("routes implementation bugs back to writer with mcp__relai__ prefix", () => {
      const prompt = buildPrompt(config({ specialization: "tester" }));
      expect(prompt).toContain("mcp__relai__create_task` → \"writer\"");
    });
  });

  describe("devops specialization", () => {
    it("includes devops role header", () => {
      const prompt = buildPrompt(config({ specialization: "devops" }));
      expect(prompt).toContain("DevOps");
    });

    it("handles build_error and ci_failure findings", () => {
      const prompt = buildPrompt(config({ specialization: "devops" }));
      expect(prompt).toContain("build_error");
      expect(prompt).toContain("ci_failure");
    });
  });
});
