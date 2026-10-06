import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  let realLegacyDir: string | undefined;

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
    realConfigDir = process.env.PITBOSS_CONFIG_DIR;
    realLegacyDir = process.env.RELAI_CONFIG_DIR;
    delete process.env.RELAI_CONFIG_DIR;
    // Redirect home so an accidental write to the default location lands
    // somewhere we can assert on instead of the developer's real config.
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.PITBOSS_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (realLegacyDir === undefined) delete process.env.RELAI_CONFIG_DIR;
    else process.env.RELAI_CONFIG_DIR = realLegacyDir;
    if (realConfigDir === undefined) delete process.env.PITBOSS_CONFIG_DIR;
    else process.env.PITBOSS_CONFIG_DIR = realConfigDir;
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    rmSync(configDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("honours a PITBOSS_CONFIG_DIR set after this module was imported", () => {
    expect(configPath()).toBe(join(configDir, "config.json"));
  });

  it("writes into PITBOSS_CONFIG_DIR, not the home directory", () => {
    writeConfig(sample);

    expect(existsSync(join(configDir, "config.json"))).toBe(true);
    expect(existsSync(join(fakeHome, ".config", "pitboss", "config.json"))).toBe(false);
  });

  it("never touches the home directory even when it already holds a config", () => {
    // Simulates a developer with a real credential on disk: running the suite
    // must not overwrite it.
    const homeConfigDir = join(fakeHome, ".config", "pitboss");
    const homeConfig = join(homeConfigDir, "config.json");
    process.env.PITBOSS_CONFIG_DIR = homeConfigDir;
    writeConfig({ ...sample, apiToken: "t_real_credential" });
    process.env.PITBOSS_CONFIG_DIR = configDir;

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

  it("follows PITBOSS_CONFIG_DIR when it changes between calls", () => {
    writeConfig(sample);

    const second = mkdtempSync(join(tmpdir(), "relai-config-2-"));
    try {
      process.env.PITBOSS_CONFIG_DIR = second;
      expect(readConfig()).toBeNull();

      writeConfig({ ...sample, agentName: "other" });
      expect(readConfig()?.agentName).toBe("other");

      process.env.PITBOSS_CONFIG_DIR = configDir;
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
    process.env.PITBOSS_CONFIG_DIR = configDir;
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

  it("defaults to ~/.config/pitboss when PITBOSS_CONFIG_DIR is unset", () => {
    delete process.env.PITBOSS_CONFIG_DIR;
    const defaultPath = join(fakeHome, ".config", "pitboss", "config.json");

    expect(configPath()).toBe(defaultPath);
    writeConfig(sample);
    expect(existsSync(defaultPath)).toBe(true);
    expect(readConfig()).toEqual(sample);
  });

  describe("the legacy relai names", () => {
    const legacyFile = () => join(fakeHome, ".config", "relai", "config.json");
    const newFile = () => join(fakeHome, ".config", "pitboss", "config.json");
    const plantLegacy = (agentName: string) => {
      process.env.PITBOSS_CONFIG_DIR = join(fakeHome, ".config", "relai");
      writeConfig({ ...sample, agentName });
      delete process.env.PITBOSS_CONFIG_DIR;
    };

    it("still honours RELAI_CONFIG_DIR when PITBOSS_CONFIG_DIR is unset", () => {
      delete process.env.PITBOSS_CONFIG_DIR;
      process.env.RELAI_CONFIG_DIR = configDir;
      expect(configPath()).toBe(join(configDir, "config.json"));
    });

    it("prefers PITBOSS_CONFIG_DIR over RELAI_CONFIG_DIR", () => {
      process.env.RELAI_CONFIG_DIR = join(fakeHome, "legacy");
      expect(configPath()).toBe(join(configDir, "config.json"));
    });

    it("reads ~/.config/relai when ~/.config/pitboss has no config", () => {
      plantLegacy("legacy");
      expect(readConfig()?.agentName).toBe("legacy");
    });

    it("moves to ~/.config/pitboss on the next write, so no token is left behind in the legacy file", () => {
      plantLegacy("legacy");
      writeConfig({ ...sample, agentName: "migrated" });

      expect(JSON.parse(readFileSync(newFile(), "utf-8")).agentName).toBe("migrated");
      expect(existsSync(legacyFile())).toBe(false);
      expect(readConfig()?.agentName).toBe("migrated");
    });

    it("does not bring the legacy identity back when the new config is deleted", () => {
      plantLegacy("legacy");
      writeConfig({ ...sample, agentName: "migrated" });
      rmSync(newFile());

      expect(readConfig()).toBeNull();
    });

    it("says once per process where it is reading from, on stderr", async () => {
      vi.resetModules();
      const fresh = await import("./config.js");
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        plantLegacy("legacy");
        fresh.readConfig();
        fresh.readConfig();
        expect(err).toHaveBeenCalledTimes(1);
        expect(String(err.mock.calls[0][0])).toContain(legacyFile());
        expect(String(err.mock.calls[0][0])).toContain(newFile());
      } finally {
        err.mockRestore();
      }
    });

    it("says nothing once the new file exists", async () => {
      vi.resetModules();
      const fresh = await import("./config.js");
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        plantLegacy("legacy");
        fresh.writeConfig({ ...sample, agentName: "migrated" });
        fresh.readConfig();
        expect(err).not.toHaveBeenCalled();
      } finally {
        err.mockRestore();
      }
    });

    it("leaves the legacy file alone when writing to an explicit directory", () => {
      plantLegacy("legacy");
      process.env.PITBOSS_CONFIG_DIR = configDir;
      writeConfig(sample);

      expect(existsSync(legacyFile())).toBe(true);
    });

    it("never falls back to the legacy home file when a directory is set explicitly", () => {
      plantLegacy("legacy");
      process.env.PITBOSS_CONFIG_DIR = configDir;
      expect(readConfig()).toBeNull();
    });
  });

  it("does not create the home config directory as a side effect", () => {
    writeConfig(sample);
    readConfig();
    configPath();

    expect(existsSync(join(fakeHome, ".config", "pitboss"))).toBe(false);
  });
});
