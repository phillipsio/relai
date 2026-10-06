import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
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
export function configDir(): string {
  return process.env.PITBOSS_CONFIG_DIR ?? process.env.RELAI_CONFIG_DIR ?? join(homedir(), ".config", "pitboss");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function legacyConfigDir(): string {
  return join(homedir(), ".config", "relai");
}

let warned = false;
export function readablePath(name: string): string {
  const current = join(configDir(), name);
  if (existsSync(current) || process.env.PITBOSS_CONFIG_DIR || process.env.RELAI_CONFIG_DIR) return current;
  const legacy = join(legacyConfigDir(), name);
  if (!existsSync(legacy)) return current;
  if (!warned) {
    warned = true;
    console.error(`pitboss: reading ${legacy}; the next write moves it to ${current}.`);
  }
  return legacy;
}

export function readConfig(): Config | null {
  const file = readablePath("config.json");
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
  mkdirSync(dirname(file), { recursive: true });
  // Temp-then-rename, never a direct write: a plain write follows a symlink, and
  // writeFileSync's mode is ignored when the path already exists. `wx` refuses a
  // planted temp file rather than following it.
  const tmp = `${file}.relai-${randomBytes(8).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
  return file;
}

export function requireConfig(): Config {
  const config = readConfig();
  if (!config) {
    console.error("Not initialized. Run `pitboss join` first.");
    process.exit(1);
  }
  return config;
}
