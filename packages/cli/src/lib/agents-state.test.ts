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

  it("prefers PITBOSS_AGENTS_STATE over RELAI_AGENTS_STATE", () => {
    const preferred = join(dir, "pitboss-agents.json");
    process.env.PITBOSS_AGENTS_STATE = preferred;
    try {
      expect(agentsStatePath()).toBe(preferred);
    } finally {
      delete process.env.PITBOSS_AGENTS_STATE;
    }
  });

  describe("without an override", () => {
    let realHome: string | undefined;
    beforeEach(() => {
      delete process.env.RELAI_AGENTS_STATE;
      realHome = process.env.HOME;
      process.env.HOME = dir;
    });
    afterEach(() => {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    });

    it("writes under ~/.config/pitboss", () => {
      expect(agentsStatePath()).toBe(join(dir, ".config", "pitboss", "agents.json"));
    });

    it("reads ~/.config/relai until the first write moves it", () => {
      const legacy = join(dir, ".config", "relai", "agents.json");
      process.env.PITBOSS_AGENTS_STATE = legacy;
      claimWorkingDir({ agentId: "agent_old", agentName: "old", workingDir: join(dir, "old"), apiUrl: "http://x", tokenRef: "t" });
      delete process.env.PITBOSS_AGENTS_STATE;

      expect(readAgentsState().agents.map((a) => a.agentId)).toEqual(["agent_old"]);
      claimWorkingDir({ agentId: "agent_new", agentName: "new", workingDir: join(dir, "new"), apiUrl: "http://x", tokenRef: "t" });

      expect(existsSync(join(dir, ".config", "pitboss", "agents.json"))).toBe(true);
      expect(readAgentsState().agents.map((a) => a.agentId)).toEqual(["agent_old", "agent_new"]);
    });
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
