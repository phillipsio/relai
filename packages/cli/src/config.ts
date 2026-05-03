import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

export interface Config {
  apiUrl: string;
  apiToken: string;
  agentId: string;
  agentName: string;
  projectId: string;
  specialization?: string;
}

// RELAI_CONFIG_DIR lets you run multiple agent identities on one machine —
// useful for solo testing of multi-agent flows. Defaults to ~/.config/relai.
const CONFIG_DIR  = process.env.RELAI_CONFIG_DIR ?? join(homedir(), ".config", "relai");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function readConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Config & { apiSecret?: string };
    // Migrate legacy field name. Existing configs stored a shared API_SECRET as `apiSecret`;
    // it still authenticates via the API's fallback path until removed.
    if (!raw.apiToken && raw.apiSecret) raw.apiToken = raw.apiSecret;
    return raw as Config;
  } catch {
    return null;
  }
}

export function writeConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function configPath(): string {
  return CONFIG_FILE;
}

export function requireConfig(): Config {
  const config = readConfig();
  if (!config) {
    console.error("Not initialized. Run `relai init` first.");
    process.exit(1);
  }
  return config;
}
