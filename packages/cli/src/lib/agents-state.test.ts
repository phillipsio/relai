import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimWorkingDir,
  readAgentsState,
  agentsStatePath,
  WorkingDirCollisionError,
} from "./agents-state.js";

describe("agents-state", () => {
  let dir: string;
  let stateFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relai-state-"));
    stateFile = join(dir, "agents.json");
    process.env.RELAI_AGENTS_STATE = stateFile;
  });

  afterEach(() => {
    delete process.env.RELAI_AGENTS_STATE;
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the env-override path", () => {
    expect(agentsStatePath()).toBe(stateFile);
  });

  it("returns empty state when file is missing", () => {
    expect(readAgentsState()).toEqual({ agents: [] });
  });

  it("writes a claim and persists it to disk", () => {
    claimWorkingDir({
      agentId: "agent_a",
      agentName: "alice",
      workingDir: join(dir, "work"),
      apiUrl: "http://x",
      tokenRef: "abc",
    });
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].agentId).toBe("agent_a");
    expect(state.agents[0].workingDir).toBe(join(dir, "work"));
  });

  it("refuses to claim a dir already held by a different agent", () => {
    const workDir = join(dir, "work");
    claimWorkingDir({
      agentId: "agent_a", agentName: "alice", workingDir: workDir,
      apiUrl: "http://x", tokenRef: "abc",
    });
    expect(() =>
      claimWorkingDir({
        agentId: "agent_b", agentName: "bob", workingDir: workDir,
        apiUrl: "http://x", tokenRef: "def",
      }),
    ).toThrow(WorkingDirCollisionError);
  });

  it("allows the same agent to update its own claim in place", () => {
    const workDir = join(dir, "work");
    claimWorkingDir({
      agentId: "agent_a", agentName: "alice", workingDir: workDir,
      apiUrl: "http://x", tokenRef: "abc",
    });
    claimWorkingDir({
      agentId: "agent_a", agentName: "alice", workingDir: workDir,
      apiUrl: "http://y", tokenRef: "xyz",
    });
    const state = readAgentsState();
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].apiUrl).toBe("http://y");
    expect(state.agents[0].tokenRef).toBe("xyz");
  });

  it("lets the same agent move to a different working dir", () => {
    claimWorkingDir({
      agentId: "agent_a", agentName: "alice", workingDir: join(dir, "one"),
      apiUrl: "http://x", tokenRef: "abc",
    });
    claimWorkingDir({
      agentId: "agent_a", agentName: "alice", workingDir: join(dir, "two"),
      apiUrl: "http://x", tokenRef: "abc",
    });
    const state = readAgentsState();
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].workingDir).toBe(join(dir, "two"));
  });
});
