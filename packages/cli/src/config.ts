import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

export interface Config {
  apiUrl: string;
  apiSecret: string;
  agentId: string;
  agentName: string;
  projectId: string;
  specialization?: string;
}

const CONFIG_DIR = join(homedir(), ".config", "orch");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function readConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Config;
  } catch {
    return null;
  }
}

export function writeConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function requireConfig(): Config {
  const config = readConfig();
  if (!config) {
    console.error("Not initialized. Run `orch init` first.");
    process.exit(1);
  }
  return config;
}
