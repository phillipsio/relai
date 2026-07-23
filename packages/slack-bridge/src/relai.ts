import { EventSource } from "eventsource";
import type { AppEvent } from "./types.js";
import type { SlackBridgeConfig } from "./config.js";

interface PostMessageInput {
  fromAgent: string;
  toAgent?: string;
  type: "status" | "handoff" | "finding" | "decision" | "question" | "escalation" | "reply";
  body: string;
  metadata?: Record<string, unknown>;
}

// Thin REST client — relai has no shared client package; every consumer uses
// bare fetch with a Bearer header (see packages/*-worker). Responses are
// wrapped in { data }.
export class RelaiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
  ) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`relai ${init.method ?? "GET"} ${path} -> ${res.status} ${res.statusText} ${body}`);
    }
    return (await res.json()) as T;
  }

  async createThread(repoId: string, title: string): Promise<{ id: string }> {
    const { data } = await this.req<{ data: { id: string } }>(`/threads`, {
      method: "POST",
      body: JSON.stringify({ repoId, title }),
    });
    return data;
  }

  async postMessage(threadId: string, input: PostMessageInput): Promise<void> {
    await this.req(`/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  // Idempotent server-side; safe to call on every boot / new blocked thread.
  async subscribe(agentId: string, targetType: "agent" | "thread" | "task", targetId: string): Promise<void> {
    await this.req(`/subscriptions`, {
      method: "POST",
      body: JSON.stringify({ agentId, targetType, targetId }),
    });
  }
}

// Keep in sync with the API's EventKind union (packages/api/src/lib/events.ts).
// The API names each SSE event `event: <kind>`, so listeners must be attached
// per kind — onmessage only fires for unnamed events and never sees these.
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

// Opens the SSE stream and calls onEvent for each delivered event, reconnecting
// with exponential backoff. Delivery is already filtered server-side to the
// caller's subscriptions, so no client-side kind filtering is needed.
export function connectEventStream(config: SlackBridgeConfig, onEvent: (event: AppEvent) => void): void {
  function connect(): void {
    // eventsource@3's EventSourceInit has no `headers` option — the auth
    // header must go through the `fetch` hook or every connection 401s
    // (documented footgun, see packages/event-worker).
    const es = new EventSource(`${config.apiUrl}/events`, {
      fetch: (input, init) =>
        fetch(input, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${config.apiToken}` } }),
    });

    let reconnectDelay = config.reconnectBaseMs;

    es.onopen = () => {
      console.log("[slack-bridge] event stream connected");
      reconnectDelay = config.reconnectBaseMs;
    };

    const handler = (raw: MessageEvent) => {
      try {
        onEvent(JSON.parse(raw.data as string) as AppEvent);
      } catch {
        // heartbeat / comment lines carry no parseable data — ignore
      }
    };

    es.onmessage = handler;
    for (const kind of EVENT_KINDS) es.addEventListener(kind, handler);

    es.onerror = () => {
      console.warn(`[slack-bridge] stream error — reconnecting in ${Math.round(reconnectDelay / 1000)}s`);
      es.close();
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(config.reconnectMaxMs, reconnectDelay * 2);
    };
  }

  connect();
}
