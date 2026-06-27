import { EventSource } from "eventsource";
import { runClaudeSession, heartbeat, assertRepoOrExit } from "@getrelai/claude-worker";
import { createRunQueue } from "./queue.js";
import type { EventWorkerConfig } from "./config.js";

// Task-assignment events fan out via the assignee's agent-target (alsoNotify),
// but agents aren't auto-subscribed to themselves the way they are to threads
// they post in. Without this the stream never delivers new tasks assigned to us —
// the exact events this worker exists to catch. The route is idempotent, so it's
// safe on every boot.
async function selfSubscribe(config: EventWorkerConfig): Promise<void> {
  const res = await fetch(`${config.apiUrl}/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiSecret}` },
    body: JSON.stringify({ agentId: config.agentId, targetType: "agent", targetId: config.agentId }),
  });
  if (!res.ok) {
    throw new Error(`self-subscribe failed (${res.status} ${res.statusText})`);
  }
}

// SSE-driven run loop, factored out so other packages (e.g. @getrelai/agent's
// self-registering persistent service) can run it in-process.
export async function runEventWorker(config: EventWorkerConfig): Promise<never> {
  console.log(`[event-worker] Starting — agent ${config.agentId}, watching ${config.apiUrl}/events`);
  console.log(`[event-worker] Repo: ${config.repoPath} | Model: ${config.model}`);

  await assertRepoOrExit(config, "[event-worker]");
  await selfSubscribe(config);

  const queue = createRunQueue(async () => {
    await heartbeat(config, "[event-worker]");
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
    //
    // eventsource@3's EventSourceInit has no `headers` option (only
    // `withCredentials`/`fetch`) — a `headers` property here is silently
    // ignored at runtime despite type-checking via the `as` cast this
    // replaced, so the Authorization header was never actually sent and
    // every connection failed with 401. Inject it via the `fetch` hook,
    // which the library documents and actually wires up.
    const es = new EventSource(`${config.apiUrl}/events`, {
      fetch: (input, init) =>
        fetch(input, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${config.apiSecret}` } }),
    });

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

  // Catch up on anything that landed while this process was down before
  // opening the live stream — recentEvents from /session/start covers the gap.
  queue.notify();
  connect();

  return new Promise<never>(() => {}); // run forever; connect()/queue manage their own lifecycle
}
