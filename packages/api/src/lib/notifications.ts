import { eq, and, inArray, isNull } from "drizzle-orm";
import { createHmac, randomBytes } from "node:crypto";
import { notificationChannels, type Db } from "@getrelai/db";
import { bus, resolveSubscribers, type AppEvent } from "./events.js";

// Trip the breaker after this many consecutive failures. Cleared on success or
// when an operator PUTs `disabled: false`.
const FAILURE_THRESHOLD = 5;

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
  const agentIds = await resolveSubscribers(db, event);
  if (agentIds.length === 0) return;

  const channels = await db
    .select()
    .from(notificationChannels)
    .where(and(
      inArray(notificationChannels.agentId, agentIds),
      isNull(notificationChannels.disabledAt),
    ));

  await Promise.all(channels.map((ch) => deliverOne(db, ch, event, opts)));
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

async function deliverOne(db: Db, channel: Channel, event: AppEvent, opts: DeliverOptions): Promise<void> {
  const config = channel.config as { url: string; headers?: Record<string, string> };
  const retries     = opts.retries     ?? DEFAULT_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  const secret = await ensureSecret(db, channel);
  const body = JSON.stringify({
    id:         event.id,
    kind:       event.kind,
    projectId:  event.projectId,
    targetType: event.targetType,
    targetId:   event.targetId,
    payload:    event.payload,
    createdAt:  event.createdAt,
  });
  const timestamp = new Date().toISOString();
  const signature = sign(secret, timestamp, body);
  const headers: Record<string, string> = {
    "Content-Type":      "application/json",
    "X-Relai-Timestamp": timestamp,
    "X-Relai-Signature": `sha256=${signature}`,
    ...(config.headers ?? {}),
  };

  let lastError = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await attemptOnce(config.url, headers, body);
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
