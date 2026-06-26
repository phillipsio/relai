import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

let fakeHome: string;
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => fakeHome };
});

describe("installLinux", () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "relai-agent-linux-test-"));
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("shell-quotes a repo path containing a single quote so the unit's ExecStart stays valid", async () => {
    const { installLinux } = await import("./service-linux.js");
    installLinux({
      label: "com.relai.agent.agent_1",
      agentId: "agent_1",
      args: ["node", "cli.js", "run", "/tmp/it's a repo"],
      env: { PATH: "/usr/bin" },
      workingDirectory: "/tmp/it's a repo",
    });

    const unitPath = join(fakeHome, ".config", "systemd", "user", "com.relai.agent.agent_1.service");
    const unit = readFileSync(unitPath, "utf8");
    expect(unit).toContain(`'/tmp/it'\\''s a repo'`);
  });

  it("places the secret only in an Environment= line, never in ExecStart", async () => {
    const { installLinux } = await import("./service-linux.js");
    installLinux({
      label: "com.relai.agent.agent_2",
      agentId: "agent_2",
      args: ["node", "cli.js", "run", "/tmp/repo"],
      env: { PATH: "/usr/bin", API_SECRET: "sk-should-only-be-here" },
      workingDirectory: "/tmp/repo",
    });

    const unitPath = join(fakeHome, ".config", "systemd", "user", "com.relai.agent.agent_2.service");
    const unit = readFileSync(unitPath, "utf8");
    const execStartLine = unit.split("\n").find((l) => l.startsWith("ExecStart="));
    expect(execStartLine).not.toContain("sk-should-only-be-here");
    expect(unit).toContain("Environment=API_SECRET='sk-should-only-be-here'");
  });

  it("writes the unit with 0600 permissions (it carries a live agent token)", async () => {
    const { installLinux } = await import("./service-linux.js");
    installLinux({
      label: "com.relai.agent.agent_3",
      agentId: "agent_3",
      args: ["node", "cli.js", "run", "/tmp/repo"],
      env: { PATH: "/usr/bin" },
      workingDirectory: "/tmp/repo",
    });

    const unitPath = join(fakeHome, ".config", "systemd", "user", "com.relai.agent.agent_3.service");
    const mode = statSync(unitPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("attempts to enable lingering and warns instead of failing install when it can't", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "loginctl") throw new Error("permission denied");
      return Buffer.from("");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { installLinux } = await import("./service-linux.js");

    expect(() =>
      installLinux({
        label: "com.relai.agent.agent_4",
        agentId: "agent_4",
        args: ["node", "cli.js", "run", "/tmp/repo"],
        env: { PATH: "/usr/bin" },
        workingDirectory: "/tmp/repo",
      }),
    ).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("loginctl enable-linger"));
    warnSpy.mockRestore();
  });

  it("refuses to write a unit when agentId contains a newline (unit-directive injection)", async () => {
    const { installLinux } = await import("./service-linux.js");
    expect(() =>
      installLinux({
        label: "com.relai.agent.agent_5",
        agentId: "agent_5\nExecStartPost=/bin/sh -c 'evil'",
        args: ["node", "cli.js", "run", "/tmp/repo"],
        env: { PATH: "/usr/bin" },
        workingDirectory: "/tmp/repo",
      }),
    ).toThrow(/newline/);
  });

  it("refuses to write a unit when workingDirectory contains a newline", async () => {
    const { installLinux } = await import("./service-linux.js");
    expect(() =>
      installLinux({
        label: "com.relai.agent.agent_6",
        agentId: "agent_6",
        args: ["node", "cli.js", "run", "/tmp/repo"],
        env: { PATH: "/usr/bin" },
        workingDirectory: "/tmp/repo\nExecStartPost=/bin/sh -c 'evil'",
      }),
    ).toThrow(/newline/);
  });
});
