import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginCommand } from "./invite.js";

const REPO_URL = "git@github.com:phillipsio/relai.git";
const OTHER_URL = "git@github.com:phillipsio/other.git";

interface MockProject {
  id: string;
  name: string;
  repoUrl: string | null;
}

function setupFetchMock(opts: {
  agentId?: string;
  agentName?: string;
  projectId?: string;
  project: MockProject;
}) {
  const agentId = opts.agentId ?? "agent_a";
  const agentName = opts.agentName ?? "alice";
  const projectId = opts.projectId ?? opts.project.id;

  const fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/session/start") {
      return new Response(JSON.stringify({
        data: {
          agent: { id: agentId, name: agentName, specialization: null, workerType: null, repoPath: null },
          project: { id: projectId, name: opts.project.name, context: null, defaultAssignee: null },
          tasks: [],
          unreadMessages: [],
          openThreads: [],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.pathname === `/projects/${projectId}`) {
      return new Response(JSON.stringify({
        data: { id: opts.project.id, name: opts.project.name, repoUrl: opts.project.repoUrl, createdAt: new Date().toISOString() },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: `unmocked ${u.pathname}` } }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function gitInit(dir: string, remote?: string) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  if (remote) {
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  }
}

describe("loginCommand", () => {
  let workdir: string;
  let configDir: string;
  let stateFile: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errSpy: any;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "relai-login-work-"));
    configDir = mkdtempSync(join(tmpdir(), "relai-login-cfg-"));
    stateFile = join(configDir, "agents.json");
    process.env.RELAI_CONFIG_DIR = configDir;
    process.env.RELAI_AGENTS_STATE = stateFile;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.RELAI_CONFIG_DIR;
    delete process.env.RELAI_AGENTS_STATE;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(workdir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("succeeds from a clean clone of the right repo and writes agents.json", async () => {
    gitInit(workdir, REPO_URL);
    setupFetchMock({ project: { id: "proj_1", name: "relai", repoUrl: REPO_URL } });

    await loginCommand({ token: "t_abc", api: "http://localhost:3010", workingDir: workdir });

    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].agentId).toBe("agent_a");
    expect(state.agents[0].apiUrl).toBe("http://localhost:3010");
    expect(state.agents[0].tokenRef).toBeTruthy();
    expect(state.agents[0].tokenRef).not.toBe("t_abc");
  });

  it("refuses login when CWD is an unrelated repo", async () => {
    gitInit(workdir, OTHER_URL);
    setupFetchMock({ project: { id: "proj_1", name: "relai", repoUrl: REPO_URL } });

    await expect(
      loginCommand({ token: "t_abc", api: "http://localhost:3010", workingDir: workdir }),
    ).rejects.toThrow("__exit__:1");

    const errText = errSpy.mock.calls.flat().join("\n");
    expect(errText).toMatch(/this agent is for/);
    expect(existsSync(stateFile)).toBe(false);
  });

  it("refuses login when CWD is not a git repo and project has a repoUrl", async () => {
    setupFetchMock({ project: { id: "proj_1", name: "relai", repoUrl: REPO_URL } });

    await expect(
      loginCommand({ token: "t_abc", api: "http://localhost:3010", workingDir: workdir }),
    ).rejects.toThrow("__exit__:1");

    const errText = errSpy.mock.calls.flat().join("\n");
    expect(errText).toMatch(/Not in a git repo/);
    expect(errText).toMatch(/git clone /);
  });

  it("refuses login of a second agent in the same directory with a worktree hint", async () => {
    gitInit(workdir, REPO_URL);
    setupFetchMock({
      agentId: "agent_a", agentName: "alice",
      project: { id: "proj_1", name: "relai", repoUrl: REPO_URL },
    });
    await loginCommand({ token: "t_abc", api: "http://localhost:3010", workingDir: workdir });

    // Now second agent tries
    setupFetchMock({
      agentId: "agent_b", agentName: "bob",
      project: { id: "proj_1", name: "relai", repoUrl: REPO_URL },
    });
    errSpy.mockClear();

    await expect(
      loginCommand({ token: "t_def", api: "http://localhost:3010", workingDir: workdir }),
    ).rejects.toThrow("__exit__:1");

    const errText = errSpy.mock.calls.flat().join("\n");
    expect(errText).toMatch(/already using/);
    expect(errText).toMatch(/git worktree add/);
    expect(errText).toMatch(/relai-bob/);

    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].agentId).toBe("agent_a");
  });

  it("re-logs in the same agent in the same dir and updates the entry", async () => {
    gitInit(workdir, REPO_URL);
    setupFetchMock({
      agentId: "agent_a", agentName: "alice",
      project: { id: "proj_1", name: "relai", repoUrl: REPO_URL },
    });
    await loginCommand({ token: "t_abc", api: "http://localhost:3010", workingDir: workdir });

    // Re-login same agent, different token
    setupFetchMock({
      agentId: "agent_a", agentName: "alice",
      project: { id: "proj_1", name: "relai", repoUrl: REPO_URL },
    });
    await loginCommand({ token: "t_xyz", api: "http://localhost:3010", workingDir: workdir });

    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].agentId).toBe("agent_a");
    expect(state.agents[0].tokenRef).toBeTruthy();
  });
});
