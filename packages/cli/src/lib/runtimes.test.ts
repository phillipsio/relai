import { describe, it, expect } from "vitest";
import { mergeMcpServer, runtimeTargets, RUNTIMES } from "./runtimes.js";

const ENTRY = {
  command: "npx",
  args: ["-y", "@getrelai/mcp-server"],
  env: { API_URL: "https://api.relai.dev", API_SECRET: "aio_x", AGENT_ID: "agent_1", REPO_ID: "repo_1" },
};

describe("mergeMcpServer", () => {
  it("creates the shape when there is no file yet", () => {
    expect(mergeMcpServer(null, "relai", ENTRY)).toEqual({ mcpServers: { relai: ENTRY } });
  });

  it("keeps other MCP servers untouched", () => {
    const existing = { mcpServers: { playwright: { command: "npx", args: ["playwright"] } } };
    const merged = mergeMcpServer(existing, "relai", ENTRY);
    expect(merged.mcpServers.playwright).toEqual(existing.mcpServers.playwright);
    expect(merged.mcpServers.relai).toEqual(ENTRY);
  });

  it("keeps unrelated top-level keys", () => {
    const merged = mergeMcpServer({ theme: "dark", mcpServers: {} }, "relai", ENTRY);
    expect(merged.theme).toBe("dark");
  });

  it("replaces an existing relai entry rather than adding a second", () => {
    const existing = { mcpServers: { relai: { command: "old", args: [], env: { API_URL: "http://localhost:3010" } } } };
    const merged = mergeMcpServer(existing, "relai", ENTRY);
    expect(Object.keys(merged.mcpServers)).toEqual(["relai"]);
    expect(merged.mcpServers.relai).toEqual(ENTRY);
  });

  it("does not mutate what it was given", () => {
    const existing = { mcpServers: { other: { command: "x" } } };
    const snapshot = JSON.stringify(existing);
    mergeMcpServer(existing, "relai", ENTRY);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it("refuses a file whose mcpServers is not an object, rather than flattening it", () => {
    // Overwriting here would silently delete whatever the user actually had.
    expect(() => mergeMcpServer({ mcpServers: [] as unknown as Record<string, unknown> }, "relai", ENTRY)).toThrow(/mcpServers/);
    expect(() => mergeMcpServer("nonsense" as unknown as Record<string, unknown>, "relai", ENTRY)).toThrow();
  });
});

describe("runtimeTargets", () => {
  const home = "/home/jim";
  const repo = "/home/jim/code/app";

  it("puts Claude Code and Cursor in the repo, not the home directory", () => {
    expect(runtimeTargets("claude", { home, repo })).toEqual(["/home/jim/code/app/.mcp.json"]);
    expect(runtimeTargets("cursor", { home, repo })).toEqual(["/home/jim/code/app/.cursor/mcp.json"]);
  });

  it("puts the home-scoped runtimes under the home directory", () => {
    expect(runtimeTargets("gemini", { home, repo })).toEqual(["/home/jim/.gemini/settings.json"]);
    expect(runtimeTargets("windsurf", { home, repo })).toEqual(["/home/jim/.codeium/windsurf/mcp_config.json"]);
  });

  it("falls back to the CLI's own config for a generic MCP client", () => {
    expect(runtimeTargets("mcp", { home, repo })).toEqual(["/home/jim/.config/relai/config.json"]);
  });

  it("names a target for every runtime it offers, so none can be silently skipped", () => {
    for (const r of RUNTIMES) {
      expect(runtimeTargets(r.workerType, { home, repo }).length).toBeGreaterThan(0);
    }
  });

  it("never writes outside the repo or the home directory", () => {
    for (const r of RUNTIMES) {
      for (const t of runtimeTargets(r.workerType, { home, repo })) {
        expect(t.startsWith(home) || t.startsWith(repo)).toBe(true);
        expect(t).not.toContain("..");
      }
    }
  });
});
