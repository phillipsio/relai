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

// Cheap pre-spawn gate: check the two REST signals a spawned session would
// actually act on (its assigned/in_progress tasks, its unread messages)
// before paying for a `claude --print` process. Mirrors what the session's
// own "if no assigned tasks, stop immediately" prompt guard checks, but
// without the cost of spawning first (packages/claude-worker/src/prompt.ts).
async function hasWork(config: EventWorkerConfig): Promise<boolean> {
  const headers = { Authorization: `Bearer ${config.apiSecret}` };
  const [tasksRes, messagesRes] = await Promise.all([
    fetch(`${config.apiUrl}/tasks?repoId=${config.repoId}&assignedTo=${config.agentId}&status=assigned,in_progress`, { headers }),
    fetch(`${config.apiUrl}/messages/unread?agentId=${config.agentId}&repoId=${config.repoId}`, { headers }),
  ]);
  if (!tasksRes.ok || !messagesRes.ok) {
    throw new Error(`has-work check failed (tasks ${tasksRes.status}, messages ${messagesRes.status})`);
  }
  const { data: myTasks } = (await tasksRes.json()) as { data: unknown[] };
  const { data: unreadMessages } = (await messagesRes.json()) as { data: unknown[] };
  return myTasks.length > 0 || unreadMessages.length > 0;
}

// Mirrors the `EventKind` union in packages/api/src/lib/events.ts. The API
// writes each event with a named `event: <kind>` SSE field (see
// packages/api/src/routes/events.ts) rather than the default unnamed
// "message" type, so listeners must be registered per kind via
// `addEventListener` — `onmessage` only fires for unnamed events and never
// sees these. Keep this list in sync with the server's EventKind union.
const EVENT_KINDS = [
  "message.posted",
  "task.created",
  "task.proposed",
  "task.committed",
  "task.proposal_rejected",
  "task.proposed_overdue",
  "task.updated",
  "task.blocked",
  "task.pending_verification",
  "task.stalled",
  "task.verified",
  "task.verification_failed",
  "task.review_requested",
  "task.review_submitted",
  "task.review_overdue",
  "thread.created",
  "thread.concluded",
] as const;

// SSE-driven run loop, factored out so other packages (e.g. @getrelai/agent's
// self-registering persistent service) can run it in-process.
export async function runEventWorker(config: EventWorkerConfig): Promise<never> {
  console.log(`[event-worker] Starting — agent ${config.agentId}, watching ${config.apiUrl}/events`);
  console.log(`[event-worker] Repo: ${config.repoPath} | Model: ${config.model}`);

  await assertRepoOrExit(config, "[event-worker]");
  await selfSubscribe(config);

  const queue = createRunQueue(async () => {
    await heartbeat(config, "[event-worker]");

    let shouldRun: boolean;
    try {
      shouldRun = await hasWork(config);
    } catch (err) {
      // A transient network blip on the cheap check must not silently stop
      // the worker from doing real work — fall through and spawn.
      console.warn(
        "[event-worker] has-work check failed — spawning session to be safe:",
        err instanceof Error ? err.message : String(err),
      );
      shouldRun = true;
    }

    if (!shouldRun) {
      console.log("[event-worker] No work — skipping session");
      return;
    }

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

    const onEvent = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data as string);
        console.log(`[event-worker] Event: ${event.kind ?? "unknown"}`);
      } catch {
        // Comment/heartbeat lines don't carry parseable data — ignore.
      }
      queue.notify();
    };

    es.onmessage = onEvent;
    for (const kind of EVENT_KINDS) {
      es.addEventListener(kind, onEvent);
    }

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
