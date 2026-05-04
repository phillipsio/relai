import { eq, and, inArray, isNull } from "drizzle-orm";
import { notificationChannels, type Db } from "@getrelai/db";
import { bus, resolveSubscribers, type AppEvent } from "./events.js";

// Trip the breaker after this many consecutive failures. Cleared on success or
// when an operator PUTs `disabled: false`.
const FAILURE_THRESHOLD = 5;

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

export async function deliver(db: Db, event: AppEvent): Promise<void> {
  const agentIds = await resolveSubscribers(db, event);
  if (agentIds.length === 0) return;

  const channels = await db
    .select()
    .from(notificationChannels)
    .where(and(
      inArray(notificationChannels.agentId, agentIds),
      isNull(notificationChannels.disabledAt),
    ));

  await Promise.all(channels.map((ch) => deliverOne(db, ch, event)));
}

async function deliverOne(db: Db, channel: Channel, event: AppEvent): Promise<void> {
  const config = channel.config as { url: string; headers?: Record<string, string> };

  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.headers ?? {}) },
      body: JSON.stringify({
        id:         event.id,
        kind:       event.kind,
        projectId:  event.projectId,
        targetType: event.targetType,
        targetId:   event.targetId,
        payload:    event.payload,
        createdAt:  event.createdAt,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    await db.update(notificationChannels).set({
      lastDeliveredAt: new Date(),
      failureCount:    0,
      lastError:       null,
    }).where(eq(notificationChannels.id, channel.id));
  } catch (err) {
    const message  = err instanceof Error ? err.message : String(err);
    const nextCount = channel.failureCount + 1;
    await db.update(notificationChannels).set({
      failureCount: nextCount,
      lastErrorAt:  new Date(),
      lastError:    message,
      ...(nextCount >= FAILURE_THRESHOLD ? { disabledAt: new Date() } : {}),
    }).where(eq(notificationChannels.id, channel.id));
  }
}
