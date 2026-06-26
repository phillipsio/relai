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

describe("installMacOS", () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "relai-agent-macos-test-"));
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("XML-escapes a repo path containing & < > so the plist stays well-formed", async () => {
    const { installMacOS } = await import("./service-macos.js");
    installMacOS({
      label: "com.relai.agent.agent_1",
      agentId: "agent_1",
      args: ["node", "cli.js", "run", "/tmp/repo"],
      env: { PATH: "/usr/bin" },
      workingDirectory: "/tmp/repo & <evil> dir",
    });

    const plistPath = join(fakeHome, "Library", "LaunchAgents", "com.relai.agent.agent_1.plist");
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("/tmp/repo &amp; &lt;evil&gt; dir");
    expect(plist).not.toContain("/tmp/repo & <evil> dir");
  });

  it("places the secret only in EnvironmentVariables, never in ProgramArguments", async () => {
    const { installMacOS } = await import("./service-macos.js");
    installMacOS({
      label: "com.relai.agent.agent_2",
      agentId: "agent_2",
      args: ["node", "cli.js", "run", "/tmp/repo"],
      env: { PATH: "/usr/bin", API_SECRET: "sk-should-only-be-here" },
      workingDirectory: "/tmp/repo",
    });

    const plistPath = join(fakeHome, "Library", "LaunchAgents", "com.relai.agent.agent_2.plist");
    const plist = readFileSync(plistPath, "utf8");
    const programArgsBlock = plist.slice(plist.indexOf("<key>ProgramArguments</key>"), plist.indexOf("</array>"));
    expect(programArgsBlock).not.toContain("sk-should-only-be-here");
    expect(plist).toContain("sk-should-only-be-here"); // present somewhere — in EnvironmentVariables
  });

  it("writes the plist with 0600 permissions (it carries a live agent token)", async () => {
    const { installMacOS } = await import("./service-macos.js");
    installMacOS({
      label: "com.relai.agent.agent_3",
      agentId: "agent_3",
      args: ["node", "cli.js", "run", "/tmp/repo"],
      env: { PATH: "/usr/bin" },
      workingDirectory: "/tmp/repo",
    });

    const plistPath = join(fakeHome, "Library", "LaunchAgents", "com.relai.agent.agent_3.plist");
    const mode = statSync(plistPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
