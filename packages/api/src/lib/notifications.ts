import { eq, and, inArray, isNull } from "drizzle-orm";
import { createHmac, randomBytes } from "node:crypto";
import { notificationChannels, repos, type Db } from "@getrelai/db";
import { bus, resolveSubscribers, type AppEvent, type EventKind } from "./events.js";

// Trip the breaker after this many consecutive failures. Cleared on success or
// when an operator PUTs `disabled: false`.
const FAILURE_THRESHOLD = 5;

// Owner-scoped channels fire only on attention-transition events — the "this
// needs a human" moments — across all of that owner's repos, rather than on
// every event the way agent/subscription channels do.
//
// Criterion for adding a kind: work has stopped and will not move again without
// a person. The two `*_overdue` kinds qualify by construction — they exist only
// because a nudge went unanswered, and each is emitted once, so they cannot spam.
// `task.stalled` is deliberately absent: a slow worker is the orchestrator's
// problem, and it is the noisiest signal of the set.
export const OWNER_ATTENTION_KINDS = new Set<EventKind>([
  "task.proposed",
  "task.blocked",
  "task.pending_verification",
  "task.proposed_overdue",
  "task.review_overdue",
  "task.blocked_overdue",
]);

// Default delivery options. `retries: 2` = up to 3 attempts total.
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 200;

export type DeliverOptions = {
  retries?:     number;
  baseDelayMs?: number;
};

type Channel = typeof notificationChannels.$inferSelect;

export function startNotificationDelivery(db: Db): () => void {
  const handler = (event: AppEvent) => {
    void deliver(db, event).catch(() => {
      // Per-channel errors are recorded on the channel row; this catch only
      // guards against bugs in the dispatcher itself. Swallow to keep the bus
      // healthy.
    });
  };
  bus.on("event", handler);
  return () => bus.off("event", handler);
}

export async function deliver(db: Db, event: AppEvent, opts: DeliverOptions = {}): Promise<void> {
  const channels = await selectChannels(db, event);
  if (channels.length === 0) return;
  await Promise.all(channels.map((ch) => deliverOne(db, ch, event, opts)));
}

// Resolve the channels an event fans out to, from two independent paths:
//   1. Agent channels — the existing subscription-driven path: agents
//      subscribed to the event's target, fired for every event.
//   2. Owner channels — repo-owner channels, fired only on attention-transition
//      events, resolved via the event's repo → repos.ownerId. Independent of
//      subscriptions (an owner needn't subscribe to anything).
// Deduped by channel id (scopes are disjoint, but a defensive union is cheap).
async function selectChannels(db: Db, event: AppEvent): Promise<Channel[]> {
  const byId = new Map<string, Channel>();

  const agentIds = await resolveSubscribers(db, event);
  if (agentIds.length > 0) {
    const rows = await db
      .select()
      .from(notificationChannels)
      .where(and(
        inArray(notificationChannels.agentId, agentIds),
        isNull(notificationChannels.disabledAt),
      ));
    for (const r of rows) byId.set(r.id, r);
  }

  if (OWNER_ATTENTION_KINDS.has(event.kind) && event.repoId) {
    const [repo] = await db
      .select({ ownerId: repos.ownerId })
      .from(repos)
      .where(eq(repos.id, event.repoId));
    if (repo?.ownerId) {
      const rows = await db
        .select()
        .from(notificationChannels)
        .where(and(
          eq(notificationChannels.ownerId, repo.ownerId),
          isNull(notificationChannels.disabledAt),
        ));
      for (const r of rows) byId.set(r.id, r);
    }
  }

  return [...byId.values()];
}

function generateSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

async function ensureSecret(db: Db, channel: Channel): Promise<string> {
  if (channel.secret) return channel.secret;
  const secret = generateSecret();
  await db.update(notificationChannels)
    .set({ secret })
    .where(eq(notificationChannels.id, channel.id));
  return secret;
}

function sign(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function shouldRetry(status: number | null): boolean {
  if (status === null) return true;       // network error
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

async function attemptOnce(url: string, headers: Record<string, string>, body: string): Promise<{ ok: true } | { ok: false; status: number | null; message: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers, body });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, message: `HTTP ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, message };
  }
}

// Human-readable one-liner for Slack, since the raw event JSON (payload.task /
// payload.message) isn't meant for display. Escalation messages get a 🚨
// prefix so they stand out in a channel full of routine status pings.
function summarizeForSlack(event: AppEvent): string {
  const payload = event.payload as Record<string, unknown>;

  if (event.kind === "message.posted") {
    const message = payload.message as { type?: string; body?: string; fromAgent?: string } | undefined;
    const prefix = message?.type === "escalation" ? "🚨 Escalation" : `Message (${message?.type ?? "status"})`;
    return `*${prefix}* from \`${message?.fromAgent ?? "unknown"}\`:\n${message?.body ?? ""}`;
  }

  if (event.kind.startsWith("task.")) {
    const task = payload.task as { title?: string; status?: string; priority?: string } | undefined;
    if (task) {
      return `*Task ${event.kind.slice("task.".length)}* (${task.priority ?? "normal"}, ${task.status ?? "?"}): ${task.title ?? event.targetId}`;
    }
  }

  return `relai event: \`${event.kind}\` on ${event.targetType} \`${event.targetId}\``;
}

async function deliverOne(db: Db, channel: Channel, event: AppEvent, opts: DeliverOptions): Promise<void> {
  const retries     = opts.retries     ?? DEFAULT_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  let url: string;
  let headers: Record<string, string>;
  let body: string;

  if (channel.kind === "slack") {
    const config = channel.config as { webhookUrl: string };
    url = config.webhookUrl;
    headers = { "Content-Type": "application/json" };
    body = JSON.stringify({ text: summarizeForSlack(event) });
  } else {
    const config = channel.config as { url: string; headers?: Record<string, string> };
    const secret = await ensureSecret(db, channel);
    body = JSON.stringify({
      id:         event.id,
      kind:       event.kind,
      repoId:  event.repoId,
      targetType: event.targetType,
      targetId:   event.targetId,
      payload:    event.payload,
      createdAt:  event.createdAt,
    });
    const timestamp = new Date().toISOString();
    const signature = sign(secret, timestamp, body);
    url = config.url;
    headers = {
      "Content-Type":      "application/json",
      "X-Relai-Timestamp": timestamp,
      "X-Relai-Signature": `sha256=${signature}`,
      ...(config.headers ?? {}),
    };
  }

  let lastError = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await attemptOnce(url, headers, body);
    if (result.ok) {
      await db.update(notificationChannels).set({
        lastDeliveredAt: new Date(),
        failureCount:    0,
        lastError:       null,
      }).where(eq(notificationChannels.id, channel.id));
      return;
    }
    lastError = result.message;
    if (attempt < retries && shouldRetry(result.status)) {
      const delay = baseDelayMs * Math.pow(4, attempt);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    break;
  }

  const nextCount = channel.failureCount + 1;
  await db.update(notificationChannels).set({
    failureCount: nextCount,
    lastErrorAt:  new Date(),
    lastError:    lastError,
    ...(nextCount >= FAILURE_THRESHOLD ? { disabledAt: new Date() } : {}),
  }).where(eq(notificationChannels.id, channel.id));
}
