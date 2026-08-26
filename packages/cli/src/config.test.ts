import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig, configPath } from "./config.js";

describe("config", () => {
  let configDir: string;
  let fakeHome: string;
  let realHome: string | undefined;
  let realUserProfile: string | undefined;
  let realConfigDir: string | undefined;

  const sample = {
    apiUrl: "http://localhost:3010",
    apiToken: "t_test",
    agentId: "agent_test",
    agentName: "tester",
    repoId: "repo_test",
  };

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "relai-config-"));
    fakeHome = mkdtempSync(join(tmpdir(), "relai-home-"));
    realHome = process.env.HOME;
    realUserProfile = process.env.USERPROFILE;
    realConfigDir = process.env.RELAI_CONFIG_DIR;
    // Redirect home so an accidental write to the default location lands
    // somewhere we can assert on instead of the developer's real config.
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.RELAI_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.RELAI_CONFIG_DIR;
    else process.env.RELAI_CONFIG_DIR = realConfigDir;
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    rmSync(configDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("honours a RELAI_CONFIG_DIR set after this module was imported", () => {
    expect(configPath()).toBe(join(configDir, "config.json"));
  });

  it("writes into RELAI_CONFIG_DIR, not the home directory", () => {
    writeConfig(sample);

    expect(existsSync(join(configDir, "config.json"))).toBe(true);
    expect(existsSync(join(fakeHome, ".config", "relai", "config.json"))).toBe(false);
  });

  it("never touches the home directory even when it already holds a config", () => {
    // Simulates a developer with a real credential on disk: running the suite
    // must not overwrite it.
    const homeConfigDir = join(fakeHome, ".config", "relai");
    const homeConfig = join(homeConfigDir, "config.json");
    process.env.RELAI_CONFIG_DIR = homeConfigDir;
    writeConfig({ ...sample, apiToken: "t_real_credential" });
    process.env.RELAI_CONFIG_DIR = configDir;

    writeConfig({ ...sample, apiToken: "t_from_the_test" });

    expect(JSON.parse(readFileSync(homeConfig, "utf-8")).apiToken).toBe("t_real_credential");
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8")).apiToken).toBe(
      "t_from_the_test",
    );
  });

  it("round-trips through the overridden directory", () => {
    writeConfig(sample);
    expect(readConfig()).toEqual(sample);
  });

  it("follows RELAI_CONFIG_DIR when it changes between calls", () => {
    writeConfig(sample);

    const second = mkdtempSync(join(tmpdir(), "relai-config-2-"));
    try {
      process.env.RELAI_CONFIG_DIR = second;
      expect(readConfig()).toBeNull();

      writeConfig({ ...sample, agentName: "other" });
      expect(readConfig()?.agentName).toBe("other");

      process.env.RELAI_CONFIG_DIR = configDir;
      expect(readConfig()?.agentName).toBe("tester");
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("migrates a legacy apiSecret field to apiToken", () => {
    writeConfig(sample);
    const { apiToken, ...withoutToken } = sample;
    const legacy = { ...withoutToken, apiSecret: apiToken };
    rmSync(join(configDir, "config.json"));
    process.env.RELAI_CONFIG_DIR = configDir;
    writeConfig(legacy as never);

    expect(readConfig()?.apiToken).toBe(apiToken);
  });

  it("returns null when no config file exists", () => {
    expect(readConfig()).toBeNull();
  });

  it("returns null rather than throwing on malformed JSON", () => {
    writeFileSync(join(configDir, "config.json"), "{ not valid json");
    expect(readConfig()).toBeNull();
  });

  it("falls back to ~/.config/relai when RELAI_CONFIG_DIR is unset", () => {
    delete process.env.RELAI_CONFIG_DIR;
    const defaultPath = join(fakeHome, ".config", "relai", "config.json");

    expect(configPath()).toBe(defaultPath);
    writeConfig(sample);
    expect(existsSync(defaultPath)).toBe(true);
    expect(readConfig()).toEqual(sample);
  });

  it("does not create the home config directory as a side effect", () => {
    writeConfig(sample);
    readConfig();
    configPath();

    expect(existsSync(join(fakeHome, ".config", "relai"))).toBe(false);
  });
});
