import { EventSource } from "eventsource";
import { runClaudeSession } from "@getrelai/claude-worker";
import { checkRepoMatch, fetchRepoUrl } from "@getrelai/git";
import { loadConfig } from "./config.js";
import { createRunQueue } from "./queue.js";

const config = loadConfig();

console.log(`[event-worker] Starting — agent ${config.agentId}, watching ${config.apiUrl}/events`);
console.log(`[event-worker] Repo: ${config.repoPath} | Model: ${config.model}`);

async function assertRepoOrExit(): Promise<void> {
  const repoUrl = await fetchRepoUrl(config.apiUrl, config.repoId, config.apiSecret);
  const check = checkRepoMatch(config.repoPath, repoUrl);
  if (!check.ok) {
    console.error(`[event-worker] Repo check failed: ${check.reason}\n  ${check.fix}`);
    process.exit(1);
  }
}

async function heartbeat() {
  await fetch(`${config.apiUrl}/agents/${config.agentId}/heartbeat`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiSecret}` },
    body: "{}",
  }).catch((err) => console.warn("[event-worker] Heartbeat failed:", err.message));
}

// Task-assignment events fan out via the assignee's agent-target (alsoNotify),
// but agents aren't auto-subscribed to themselves the way they are to threads
// they post in. Without this the stream never delivers new tasks assigned to us —
// the exact events this worker exists to catch. The route is idempotent, so it's
// safe on every boot.
async function selfSubscribe(): Promise<void> {
  const res = await fetch(`${config.apiUrl}/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiSecret}` },
    body: JSON.stringify({ agentId: config.agentId, targetType: "agent", targetId: config.agentId }),
  });
  if (!res.ok) {
    throw new Error(`self-subscribe failed (${res.status} ${res.statusText})`);
  }
}

const queue = createRunQueue(async () => {
  await heartbeat();
  try {
    console.log("[event-worker] Event received — running session...");
    await runClaudeSession(config);
  } catch (err) {
    console.error("[event-worker] Session error:", err instanceof Error ? err.message : String(err));
  }
});

function connect(): void {
  // The API filters delivery to events this agent is subscribed to (see
  // packages/api/src/routes/events.ts), so anything that arrives here is
  // already relevant — no client-side kind filtering needed.
  const es = new EventSource(`${config.apiUrl}/events`, {
    headers: { Authorization: `Bearer ${config.apiSecret}` },
  } as ConstructorParameters<typeof EventSource>[1]);

  let reconnectDelay = config.reconnectBaseMs;

  es.onopen = () => {
    console.log("[event-worker] Connected to event stream");
    reconnectDelay = config.reconnectBaseMs;
  };

  es.onmessage = (raw: MessageEvent) => {
    try {
      const event = JSON.parse(raw.data as string);
      console.log(`[event-worker] Event: ${event.kind ?? "unknown"}`);
    } catch {
      // Comment/heartbeat lines don't carry parseable data — ignore.
    }
    queue.notify();
  };

  es.onerror = () => {
    console.warn(`[event-worker] Stream error — reconnecting in ${Math.round(reconnectDelay / 1000)}s`);
    es.close();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(config.reconnectMaxMs, reconnectDelay * 2);
  };
}

async function main() {
  await assertRepoOrExit();
  await selfSubscribe();
  // Catch up on anything that landed while this process was down before
  // opening the live stream — recentEvents from /session/start covers the gap.
  queue.notify();
  connect();
}

main().catch((err) => {
  console.error("[event-worker] Fatal:", err);
  process.exit(1);
});
