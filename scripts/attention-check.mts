// Prints one line per item that has newly entered an attention state, and
// nothing at all when there is no news, so a scheduler can notify on any output.
// Reuses diffAttention from the MCP owner watcher rather than restating it: the
// two drifting apart is how "needs a human" ends up meaning two things.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { diffAttention, type AttentionState, type WatchTask } from "../packages/mcp-server/src/owner-watch.js";

const STATE = process.env.ATTENTION_STATE_FILE ?? join(homedir(), ".relai-attention-seen.json");
const CREDS = process.env.RELAI_OPERATOR_MCP ?? join(homedir(), "relai-operator/.mcp.json");

const env = JSON.parse(readFileSync(CREDS, "utf8")).mcpServers.relai.env as Record<string, string>;
const apiUrl = env.API_URL ?? "http://localhost:3010";
const headers = { Authorization: `Bearer ${env.API_OWNER_TOKEN}`, "X-Owner-Id": env.OWNER_ID };

async function tasks(status: string): Promise<WatchTask[]> {
  const res = await fetch(`${apiUrl}/tasks?status=${status}`, { headers });
  if (!res.ok) throw new Error(`GET /tasks?status=${status} -> ${res.status}`);
  return ((await res.json()) as { data: WatchTask[] }).data ?? [];
}

// `null` on a missing state file is deliberate: a first run summarises rather
// than firing one notification per pre-existing item.
const prev: Map<string, AttentionState> | null = existsSync(STATE)
  ? new Map(Object.entries(JSON.parse(readFileSync(STATE, "utf8")) as Record<string, AttentionState>))
  : null;

// in_progress is queried separately because stalled work still has that status:
// only stalledAt gives it away.
const all = [
  ...(await tasks("blocked,pending_verification,proposed")),
  ...(await tasks("in_progress")),
];

const { notices, next } = diffAttention(prev, all);
// Written before printing: a crash after notifying would otherwise repeat it.
writeFileSync(STATE, JSON.stringify(Object.fromEntries(next), null, 2));
for (const n of notices) console.log(n);
