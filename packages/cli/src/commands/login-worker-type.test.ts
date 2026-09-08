import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@inquirer/prompts", () => ({
  input:  vi.fn(async () => "joining-agent"),
  select: vi.fn(async () => "writer"),
}));

const { loginCommand } = await import("./invite.js");

const REPO_URL = "git@github.com:phillipsio/relai.git";

function gitInit(dir: string, remote: string) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
}

/** Captures the accept-invite request body so the test can assert on it. */
function setupFetchMock(sent: { body?: Record<string, unknown> }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/auth/accept-invite") {
      sent.body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({
        data: { id: "agent_new", name: "joining-agent", repoId: "repo_1" },
        token: "tok_new",
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (u.pathname === "/repos/repo_1") {
      return new Response(JSON.stringify({
        data: { id: "repo_1", name: "relai", repoUrl: REPO_URL, createdAt: new Date().toISOString() },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: `unmocked ${u.pathname}` } }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("relai login --worker-type", () => {
  let workdir: string;
  let configDir: string;

  beforeEach(() => {
    workdir   = mkdtempSync(join(tmpdir(), "relai-wt-work-"));
    configDir = mkdtempSync(join(tmpdir(), "relai-wt-cfg-"));
    process.env.RELAI_CONFIG_DIR   = configDir;
    process.env.RELAI_AGENTS_STATE = join(configDir, "agents.json");
    // No RELAI_NO_INPUT here: the prompts are mocked, so setting it would
    // assert that a non-interactive run works when the real one cannot.
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    gitInit(workdir, REPO_URL);
  });

  afterEach(() => {
    delete process.env.RELAI_CONFIG_DIR;
    delete process.env.RELAI_AGENTS_STATE;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(workdir,   { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("sends the requested workerType instead of the hardcoded human", async () => {
    const sent: { body?: Record<string, unknown> } = {};
    setupFetchMock(sent);

    await loginCommand({
      invite: "code_1", api: "http://localhost:3010", workingDir: workdir, workerType: "cursor",
    });

    expect(sent.body?.workerType).toBe("cursor");
  });

  it("still defaults to human when no worker type is given", async () => {
    const sent: { body?: Record<string, unknown> } = {};
    setupFetchMock(sent);

    await loginCommand({ invite: "code_1", api: "http://localhost:3010", workingDir: workdir });

    expect(sent.body?.workerType).toBe("human");
  });

  it("refuses --worker-type on the --token path rather than exiting 0 with the label unset", async () => {
    const fetchMock = setupFetchMock({});
    const warn = vi.spyOn(console, "error");

    // No route updates an agent's type after creation, so a warning plus exit 0
    // would leave a script believing it had set one. Asserting on the exit code
    // alone proves nothing: the token path exits 1 on auth failure too, so pin
    // the refusal on never reaching the network.
    await expect(loginCommand({
      token: "t_abc", api: "http://localhost:3010", workingDir: workdir, workerType: "cursor",
    })).rejects.toThrow(/__exit__:1/);

    expect(warn.mock.calls.flat().join(" ")).toMatch(/cannot be used with --token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty worker type instead of sending it to the API", async () => {
    const sent: { body?: Record<string, unknown> } = {};
    setupFetchMock(sent);

    // `--worker-type "$VAR"` with VAR unset is the ordinary shell shape, and an
    // empty string is falsy, so a truthiness guard would wave it through.
    await expect(loginCommand({
      invite: "code_1", api: "http://localhost:3010", workingDir: workdir, workerType: "",
    })).rejects.toThrow(/__exit__:1/);

    expect(sent.body).toBeUndefined();
  });

  it("rejects a worker type outside the enum rather than sending it", async () => {
    const sent: { body?: Record<string, unknown> } = {};
    setupFetchMock(sent);

    await expect(loginCommand({
      invite: "code_1", api: "http://localhost:3010", workingDir: workdir, workerType: "emacs",
    })).rejects.toThrow(/__exit__:1/);

    expect(sent.body).toBeUndefined();
  });
});
