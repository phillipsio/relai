import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, lstatSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface Config {
  apiUrl: string;
  apiToken: string;
  agentId: string;
  agentName: string;
  repoId: string;
  specialization?: string;
}

// PITBOSS_CONFIG_DIR lets you run multiple agent identities on one machine.
// Read on every call, not cached, so an override set after import (tests) takes effect.
const configDirOverride = () => process.env.PITBOSS_CONFIG_DIR || process.env.RELAI_CONFIG_DIR || undefined;

export function configDir(): string {
  return configDirOverride() ?? join(homedir(), ".config", "pitboss");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function legacyHomePath(name: string): string {
  return join(homedir(), ".config", "relai", name);
}

const configOverridden = () => configDirOverride() !== undefined;

const warnedFor = new Set<string>();
export function readableFrom(current: string, legacy: string, overridden: boolean): string {
  if (overridden || existsSync(current) || !existsSync(legacy)) return current;
  if (!warnedFor.has(legacy)) {
    warnedFor.add(legacy);
    console.error(`pitboss: reading ${legacy}; the next write moves it to ${current}.`);
  }
  return legacy;
}

export function retireLegacy(legacy: string, current: string, overridden: boolean): void {
  if (overridden) return;
  try {
    const found = lstatSync(legacy, { throwIfNoEntry: false });
    if (!found) return;
    const [a, b] = [statSync(dirname(legacy)), statSync(dirname(current))];
    if (a.dev === b.dev && a.ino === b.ino) return;
    rmSync(legacy);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.error(`pitboss: could not remove ${legacy} (${String(err)}); it may still hold a token, delete it by hand.`);
  }
}

export function configFileInUse(): string {
  return readableFrom(configPath(), legacyHomePath("config.json"), configOverridden());
}

export function readConfig(): Config | null {
  const file = configFileInUse();
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Config & { apiSecret?: string };
    // Migrate legacy field name. Existing configs stored a shared API_SECRET as `apiSecret`;
    // it still authenticates via the API's fallback path until removed.
    if (!raw.apiToken && raw.apiSecret) raw.apiToken = raw.apiSecret;
    return raw as Config;
  } catch {
    return null;
  }
}

// Returns where it wrote. Callers used to compute that path a second time and
// chmod it, which silently diverged whenever PITBOSS_CONFIG_DIR was set.
export function writeConfig(config: Config): string {
  const file = configPath();
  const migrating = !existsSync(file);
  mkdirSync(dirname(file), { recursive: true });
  // Temp-then-rename, never a direct write: a plain write follows a symlink, and
  // writeFileSync's mode is ignored when the path already exists. `wx` refuses a
  // planted temp file rather than following it.
  const tmp = `${file}.relai-${randomBytes(8).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
  if (migrating) retireLegacy(legacyHomePath("config.json"), file, configOverridden());
  return file;
}

export function requireConfig(): Config {
  const config = readConfig();
  if (!config) {
    console.error("Not initialized. Run `relai init` first.");
    process.exit(1);
  }
  return config;
}
