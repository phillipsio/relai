import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRelaiEnv, writeRelaiEnv, requireRelaiEnv } from "./mcpConfig.js";

describe("mcpConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relai-agent-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when .mcp.json doesn't exist", () => {
    expect(readRelaiEnv(dir)).toBeNull();
  });

  it("writes a relai server block and reads it back", () => {
    writeRelaiEnv(
      dir,
      { API_URL: "http://localhost:3010", API_SECRET: "tok", AGENT_ID: "agent_1", REPO_ID: "repo_1" },
      "npx",
      ["@getrelai/mcp-server"],
    );
    const env = readRelaiEnv(dir);
    expect(env).toEqual({ API_URL: "http://localhost:3010", API_SECRET: "tok", AGENT_ID: "agent_1", REPO_ID: "repo_1" });
  });

  it("preserves other MCP servers already configured in .mcp.json", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "foo", args: [] } } }),
    );
    writeRelaiEnv(
      dir,
      { API_URL: "http://localhost:3010", API_SECRET: "tok", AGENT_ID: "agent_1", REPO_ID: "repo_1" },
      "npx",
      ["@getrelai/mcp-server"],
    );
    const json = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(json.mcpServers.other).toEqual({ command: "foo", args: [] });
    expect(json.mcpServers.relai.env.AGENT_ID).toBe("agent_1");
  });

  it("requireRelaiEnv throws a helpful error when no relai block exists", () => {
    expect(() => requireRelaiEnv(dir)).toThrow(/relai-agent init/);
  });

  it("requireRelaiEnv defaults API_URL when omitted", () => {
    writeRelaiEnv(dir, { API_SECRET: "tok", AGENT_ID: "agent_1", REPO_ID: "repo_1" } as any, "npx", []);
    const env = requireRelaiEnv(dir);
    expect(env.API_URL).toBe("http://localhost:3010");
  });

  it("requireRelaiEnv throws when only some credentials are present", () => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { relai: { env: { AGENT_ID: "agent_1" } } } }));
    expect(() => requireRelaiEnv(dir)).toThrow(/relai-agent init/);
  });

  it("writes .mcp.json with 0600 permissions (it carries a live agent token)", () => {
    writeRelaiEnv(
      dir,
      { API_URL: "http://localhost:3010", API_SECRET: "tok", AGENT_ID: "agent_1", REPO_ID: "repo_1" },
      "npx",
      ["@getrelai/mcp-server"],
    );
    const mode = statSync(join(dir, ".mcp.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("throws a clear error on malformed JSON instead of an opaque SyntaxError", () => {
    writeFileSync(join(dir, ".mcp.json"), "{ not valid json");
    expect(() => readRelaiEnv(dir)).toThrow(/not valid JSON/);
  });

  it("readRelaiEnv returns null for a relai block with no env at all", () => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { relai: { command: "npx" } } }));
    expect(readRelaiEnv(dir)).toBeNull();
  });
});
