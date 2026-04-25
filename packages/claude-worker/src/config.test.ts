import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "./config.js";

const REQUIRED_ENV: Record<string, string> = {
  AGENT_ID: "agent_test",
  PROJECT_ID: "proj_test",
  ORCHESTRATOR_API_SECRET: "secret",
  REPO_PATH: "/workspace/repo",
};

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

function unsetEnv(keys: string[]) {
  for (const k of keys) delete process.env[k];
}

describe("loadConfig", () => {
  beforeEach(() => setEnv(REQUIRED_ENV));
  afterEach(() => unsetEnv([
    ...Object.keys(REQUIRED_ENV),
    "SPECIALIZATION", "ORCHESTRATOR_API_URL", "POLL_INTERVAL_MS",
    "MAX_TASK_ROUNDS", "CLAUDE_MODEL", "CLAUDE_BIN",
  ]));

  it("loads valid config from env", () => {
    const cfg = loadConfig();
    expect(cfg.agentId).toBe("agent_test");
    expect(cfg.projectId).toBe("proj_test");
    expect(cfg.apiSecret).toBe("secret");
    expect(cfg.repoPath).toBe("/workspace/repo");
  });

  it("throws when a required var is missing", () => {
    delete process.env.AGENT_ID;
    expect(() => loadConfig()).toThrow(/AGENT_ID/);
  });

  it("throws for each missing required var", () => {
    for (const key of Object.keys(REQUIRED_ENV)) {
      const saved = process.env[key];
      delete process.env[key];
      expect(() => loadConfig(), `should throw for missing ${key}`).toThrow(key);
      process.env[key] = saved!;
    }
  });

  it("defaults specialization to writer", () => {
    expect(loadConfig().specialization).toBe("writer");
  });

  it("accepts all valid specializations", () => {
    for (const spec of ["reviewer", "architect", "writer", "tester", "devops"] as const) {
      process.env.SPECIALIZATION = spec;
      expect(loadConfig().specialization).toBe(spec);
    }
  });

  it("throws on invalid specialization", () => {
    process.env.SPECIALIZATION = "wizard";
    expect(() => loadConfig()).toThrow(/SPECIALIZATION/i);
  });

  it("defaults apiUrl to localhost:3010", () => {
    expect(loadConfig().apiUrl).toBe("http://localhost:3010");
  });

  it("defaults pollIntervalMs to 15000", () => {
    expect(loadConfig().pollIntervalMs).toBe(15000);
  });

  it("defaults maxTaskRounds to 5", () => {
    expect(loadConfig().maxTaskRounds).toBe(5);
  });

  it("defaults claudeBin to 'claude'", () => {
    expect(loadConfig().claudeBin).toBe("claude");
  });

  it("accepts custom ORCHESTRATOR_API_URL", () => {
    process.env.ORCHESTRATOR_API_URL = "http://prod:3010";
    expect(loadConfig().apiUrl).toBe("http://prod:3010");
  });

  it("accepts custom POLL_INTERVAL_MS", () => {
    process.env.POLL_INTERVAL_MS = "30000";
    expect(loadConfig().pollIntervalMs).toBe(30000);
  });

  it("accepts custom CLAUDE_BIN", () => {
    process.env.CLAUDE_BIN = "/usr/local/bin/claude";
    expect(loadConfig().claudeBin).toBe("/usr/local/bin/claude");
  });
});
