import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { ClaudeWorkerConfig } from "./config.js";

const spawnMock = vi.fn();

vi.mock("child_process", () => ({ spawn: spawnMock }));

function makeFakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe("runClaudeSession", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so the CLI falls back to subscription auth", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-should-not-leak";
    process.env.ANTHROPIC_AUTH_TOKEN = "auth-token-should-not-leak";

    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const { runClaudeSession } = await import("./session.js");

    const config: ClaudeWorkerConfig = {
      agentId: "agent_1",
      repoId: "repo_1",
      apiUrl: "http://localhost:3010",
      apiSecret: "secret",
      repoPath: "/tmp/repo",
      pollIntervalMs: 15_000,
      maxBackoffMs: 300_000,
      maxTaskRounds: 5,
      model: "sonnet",
      specialization: "writer",
      claudeBin: "claude",
    };

    const resultPromise = runClaudeSession(config);
    queueMicrotask(() => {
      proc.stdout.emit("data", Buffer.from('{"type":"result","subtype":"success"}\n'));
      proc.emit("close", 0);
    });
    await resultPromise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , spawnOpts] = spawnMock.mock.calls[0];
    expect(spawnOpts.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(spawnOpts.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });
});
