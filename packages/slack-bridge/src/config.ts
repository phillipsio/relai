export interface SlackBridgeConfig {
  apiUrl: string;
  apiToken: string; // per-agent relai bearer token (SSE rejects the shared secret)
  agentId: string;
  repoId: string;
  threadId?: string; // bound relai thread; created on boot if absent
  slackBotToken: string;
  slackAppToken: string;
  slackChannelId: string;
  userMap: Record<string, string>; // slackUserId -> relai agentId (unmapped => "human")
  agentNames: Record<string, string>; // relai agentId -> display name for outbound posts
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

function parseJsonMap(raw: string | undefined, name: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    throw new Error("not a JSON object");
  } catch (err) {
    throw new Error(`${name} must be a JSON object: ${(err as Error).message}`);
  }
}

export function loadConfig(): SlackBridgeConfig {
  const apiToken = process.env.RELAI_TOKEN ?? process.env.API_SECRET;
  const required: Record<string, string | undefined> = {
    "RELAI_TOKEN (or API_SECRET)": apiToken,
    AGENT_ID: process.env.AGENT_ID,
    REPO_ID: process.env.REPO_ID,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
    SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(", ")}`);

  return {
    apiUrl: process.env.API_URL ?? "http://localhost:3010",
    apiToken: apiToken!,
    agentId: process.env.AGENT_ID!,
    repoId: process.env.REPO_ID!,
    threadId: process.env.RELAI_THREAD_ID || undefined,
    slackBotToken: process.env.SLACK_BOT_TOKEN!,
    slackAppToken: process.env.SLACK_APP_TOKEN!,
    slackChannelId: process.env.SLACK_CHANNEL_ID!,
    userMap: parseJsonMap(process.env.SLACK_USER_MAP, "SLACK_USER_MAP"),
    agentNames: parseJsonMap(process.env.AGENT_NAME_MAP, "AGENT_NAME_MAP"),
    reconnectBaseMs: Number(process.env.RECONNECT_BASE_MS ?? 2_000),
    reconnectMaxMs: Number(process.env.RECONNECT_MAX_MS ?? 60_000),
  };
}
