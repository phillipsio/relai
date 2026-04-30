import { EventEmitter } from "node:events";
import { eq, or, and } from "drizzle-orm";
import { subscriptions, type Db } from "@relai/db";
import { newId } from "./id.js";

export type EventKind =
  | "message.posted"
  | "task.created"
  | "task.updated"
  | "thread.created"
  | "thread.concluded";

export interface AppEvent {
  id:         string;
  kind:       EventKind;
  projectId:  string;
  // The primary subject of the event. Subscriptions match against this.
  targetType: "thread" | "task" | "agent";
  targetId:   string;
  // Secondary subject used by the fan-out — e.g. message events also notify
  // subscribers of the message's `toAgent`. Optional and additive.
  alsoNotify?: Array<{ targetType: "agent" | "task" | "thread"; targetId: string }>;
  payload:    Record<string, unknown>;
  createdAt:  string;
}

// Single in-process bus. Multi-process deployments would replace this with
// Postgres LISTEN/NOTIFY or Redis pub/sub.
export const bus = new EventEmitter();
bus.setMaxListeners(0); // SSE clients accumulate; don't trip the warning.

export function publish(event: AppEvent) {
  bus.emit("event", event);
}

// Resolve which agents should receive an event, based on currently-stored
// subscriptions. Used by SSE filtering and (later) webhook fan-out.
export async function resolveSubscribers(db: Db, event: AppEvent): Promise<string[]> {
  const targets = [
    { targetType: event.targetType, targetId: event.targetId },
    ...(event.alsoNotify ?? []),
  ];

  const conditions = targets.map((t) =>
    and(
      eq(subscriptions.targetType, t.targetType),
      eq(subscriptions.targetId,   t.targetId),
    ),
  );

  const rows = await db
    .select({ agentId: subscriptions.agentId })
    .from(subscriptions)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions));

  return [...new Set(rows.map((r) => r.agentId))];
}

// Idempotent subscription. Used by routes to auto-subscribe creators/recipients
// of an action to the entity it produced (sender → thread, creator → task, etc.).
export async function ensureSubscription(
  db: Db,
  agentId: string,
  targetType: "thread" | "task" | "agent",
  targetId: string,
): Promise<void> {
  const [existing] = await db.select().from(subscriptions).where(and(
    eq(subscriptions.agentId,    agentId),
    eq(subscriptions.targetType, targetType),
    eq(subscriptions.targetId,   targetId),
  ));
  if (existing) return;
  await db.insert(subscriptions).values({
    id: newId("sub"),
    agentId, targetType, targetId,
  });
}
