export interface WebConfig {
  apiUrl: string;
  apiSecret: string;
  projectId: string;
}

const KEY = "relai_config";

export function getConfig(): WebConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as WebConfig) : null;
  } catch {
    return null;
  }
}

export function saveConfig(config: WebConfig): void {
  localStorage.setItem(KEY, JSON.stringify(config));
}

export function clearConfig(): void {
  localStorage.removeItem(KEY);
}
