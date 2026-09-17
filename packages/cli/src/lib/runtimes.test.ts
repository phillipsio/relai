import { describe, it, expect } from "vitest";
import { mergeMcpServer, runtimeTargets, detectHostRuntime, RUNTIMES, holdsRelaiToken, allRuntimeTargets } from "./runtimes.js";

const ENTRY = {
  command: "npx",
  args: ["-y", "@pitboss/cli", "mcp"],
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
      expect(runtimeTargets(r, { home, repo }).length).toBeGreaterThan(0);
    }
  });

  it("never writes outside the repo or the home directory", () => {
    for (const r of RUNTIMES) {
      for (const t of runtimeTargets(r, { home, repo })) {
        expect(t.startsWith(home) || t.startsWith(repo)).toBe(true);
        expect(t).not.toContain("..");
      }
    }
  });
});

describe("detectHostRuntime", () => {
  it("names the agent whose environment it is running in", () => {
    expect(detectHostRuntime({ CLAUDECODE: "1" })).toBe("claude");
    expect(detectHostRuntime({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe("claude");
    expect(detectHostRuntime({ CURSOR_INVOKED_AS: "agent" })).toBe("cursor");
  });

  it("returns null rather than guessing when nothing identifies itself", () => {
    expect(detectHostRuntime({})).toBeNull();
    expect(detectHostRuntime({ TERM_PROGRAM: "Apple_Terminal", SHELL: "/bin/zsh" })).toBeNull();
  });

  it("ignores a marker set to the empty string", () => {
    expect(detectHostRuntime({ CLAUDECODE: "" })).toBeNull();
  });

  it("does not claim a runtime it cannot actually detect", () => {
    for (const env of [{ WINDSURF_SESSION_ID: "1" }, { GEMINI_CLI: "1" }, { CODEX_SESSION_ID: "1" }, { COPILOT_AGENT_ID: "1" }]) {
      expect(detectHostRuntime(env)).toBeNull();
    }
  });
});

// Rotation kills the token wherever it lives, and it lives in more than one
// file: join writes it into every runtime config the agent's host reads. Before
// rotation revoked anything, a stale copy kept working, so nothing had to find
// them. Now a missed copy is an agent that 401s on its next call, and for a
// watcher that failure is invisible from inside the session.
// Rotation kills the token wherever it lives, and it lives in more than one
// file: join writes it into every runtime config the agent's host reads. This
// only IDENTIFIES them. Rewriting them is a separate, larger job (symlinks into
// dotfiles repos, git-tracked files, JSONC, ~/.claude.json's nested project
// scopes, atomic replace) and a rotate that half-rewrites is worse than one
// that names the files and lets the operator do it.
describe("holdsRelaiToken", () => {
  const cfg = (token: string) => ({
    mcpServers: { relai: { command: "tsx", env: { API_URL: "http://x", API_SECRET: token } } },
  });

  it("recognises a config holding this token", () => {
    expect(holdsRelaiToken(cfg("old"), "old")).toBe(true);
  });

  // The match on the exact token is what keeps a sibling agent's config in the
  // same repo out of the report.
  it("ignores a config holding a different agent's token", () => {
    expect(holdsRelaiToken(cfg("someone-elses"), "old")).toBe(false);
  });

  it("finds it in ~/.claude.json's nested per-project scopes, not just the top level", () => {
    // The CLI's own invite snippet and AGENTS.md both point people at
    // ~/.claude.json, where entries live under projects["<path>"].mcpServers.
    const nested = { projects: { "/home/jim/code/app": cfg("old"), "/home/jim/other": cfg("different") } };
    expect(holdsRelaiToken(nested, "old")).toBe(true);
    expect(holdsRelaiToken(nested, "nobody")).toBe(false);
  });

  it("returns false rather than throwing on shapes it does not understand", () => {
    for (const junk of [null, "nonsense", 42, [], { mcpServers: [] }, { mcpServers: { relai: "nope" } }, { projects: 7 }]) {
      expect(holdsRelaiToken(junk as never, "old")).toBe(false);
    }
  });

  it("does not match an entry with no API_SECRET when the token is undefined", () => {
    // Config.apiToken is typed string but a hand-edited config may omit it.
    const noSecret = { mcpServers: { relai: { command: "tsx", env: {} } } };
    expect(holdsRelaiToken(noSecret, undefined as never)).toBe(false);
  });
});

describe("allRuntimeTargets", () => {
  it("covers every runtime, because rotate cannot know which one wrote the config", () => {
    // The CLI config stores no workerType, so rotation checks all of them and
    // lets the token match decide which are really this agent's.
    const targets = allRuntimeTargets({ home: "/home/jim", repo: "/home/jim/code/app" });
    for (const w of RUNTIMES) {
      for (const t of runtimeTargets(w, { home: "/home/jim", repo: "/home/jim/code/app" })) {
        expect(targets).toContain(t);
      }
    }
  });

  it("lists each path once even where two runtimes share one", () => {
    const targets = allRuntimeTargets({ home: "/home/jim", repo: "/home/jim/code/app" });
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("includes ~/.claude.json, which the CLI's own invite snippet tells people to use", () => {
    expect(allRuntimeTargets({ home: "/home/jim", repo: "/home/jim/code/app" })).toContain("/home/jim/.claude.json");
  });
});
