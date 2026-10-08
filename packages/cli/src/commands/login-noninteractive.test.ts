import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loginCommand } from "./invite.js";

const CLI_DIR = resolve(__dirname, "../..");
const TSX = join(CLI_DIR, "node_modules/.bin/tsx");
const ENTRY = join(CLI_DIR, "src/index.ts");
const REPO_URL = "git@github.com:phillipsio/relai.git";

function runCli(args: string[], env: Record<string, string>) {
  const r = spawnSync(TSX, [ENTRY, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RELAI_NO_INPUT: "", ...env },
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

describe("login without a TTY (spawned, real prompt path)", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "relai-login-ni-"));
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("exits 2 naming --name when stdin is not a TTY and no name is given", () => {
    const r = runCli(
      ["login", "--invite", "inv_never_redeemed", "--api", "http://127.0.0.1:9"],
      { PITBOSS_CONFIG_DIR: configDir, PITBOSS_AGENTS_STATE: join(configDir, "agents.json") },
    );
    expect(r.stderr).toMatch(/--name/);
    expect(r.status).toBe(2);
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });

  it("exits 2 naming --api under --no-input when the API URL is omitted", () => {
    const r = runCli(
      ["--no-input", "login", "--invite", "inv_never_redeemed", "--name", "bot"],
      { PITBOSS_CONFIG_DIR: configDir, PITBOSS_AGENTS_STATE: join(configDir, "agents.json") },
    );
    expect(r.stderr).toMatch(/--api/);
    expect(r.status).toBe(2);
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });
});

describe("login non-interactive redeem (in-process)", () => {
  let workdir: string;
  let configDir: string;
  let acceptBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "relai-login-ni-work-"));
    configDir = mkdtempSync(join(tmpdir(), "relai-login-ni-cfg-"));
    process.env.PITBOSS_CONFIG_DIR = configDir;
    process.env.PITBOSS_AGENTS_STATE = join(configDir, "agents.json");
    process.env.RELAI_NO_INPUT = "1";
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workdir });
    execFileSync("git", ["remote", "add", "origin", REPO_URL], { cwd: workdir });
    acceptBody = undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/auth/accept-invite") {
        acceptBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          data: { id: "agent_n", name: acceptBody!.name, repoId: "repo_1", specialization: acceptBody!.specialization ?? "tester" },
          token: "t_new",
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (u.pathname === "/repos/repo_1") {
        return new Response(JSON.stringify({
          data: { id: "repo_1", name: "relai", repoUrl: REPO_URL, createdAt: new Date().toISOString() },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.PITBOSS_CONFIG_DIR;
    delete process.env.PITBOSS_AGENTS_STATE;
    delete process.env.RELAI_NO_INPUT;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(workdir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("redeems with --name and omits specialization so the invite's suggestion applies", async () => {
    await loginCommand({ invite: "inv_x", api: "http://localhost:3010", name: "bot", workingDir: workdir, workerType: "cursor" });

    expect(acceptBody).toEqual({ code: "inv_x", name: "bot", workerType: "cursor" });
    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(cfg.agentId).toBe("agent_n");
    expect(cfg.specialization).toBe("tester");
  });

  it("passes --specialization through", async () => {
    await loginCommand({ invite: "inv_x", api: "http://localhost:3010", name: "bot", specialization: "reviewer", workingDir: workdir });

    expect(acceptBody).toMatchObject({ name: "bot", specialization: "reviewer" });
  });
});
