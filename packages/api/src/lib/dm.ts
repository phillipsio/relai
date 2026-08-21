import { eq, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { threads, type Db } from "@getrelai/db";
import { newId } from "./id.js";

// Unordered: alice→bob and bob→alice must resolve to one conversation.
export function dmKeyFor(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export function isDmParticipant(thread: { type: string | null; dmKey: string | null }, agentId: string): boolean {
  if (thread.type !== "dm" || !thread.dmKey) return false;
  return thread.dmKey.split(":").includes(agentId);
}

// repoId satisfies the FK only. `dmKey` is the access boundary, which is what
// lets a DM cross repos and keeps a repo-mate out of it.
export async function ensureDmThread(
  db: Db,
  a: string,
  b: string,
  repoId: string,
): Promise<typeof threads.$inferSelect> {
  const key = dmKeyFor(a, b);

  const [existing] = await db.select().from(threads).where(eq(threads.dmKey, key));
  if (existing) return existing;

  const [created] = await db
    .insert(threads)
    .values({ id: newId("thread"), repoId, title: `DM: ${key}`, type: "dm", dmKey: key })
    .onConflictDoNothing({ target: threads.dmKey })
    .returning();
  if (created) return created;

  // Lost the insert race to the other participant; theirs is the thread.
  const [winner] = await db.select().from(threads).where(eq(threads.dmKey, key));
  if (!winner) throw new Error(`DM thread ${key} vanished between insert and re-read`);
  return winner;
}

// OR this into a repo-scoped predicate so a cross-repo DM still reaches an
// inbox that is otherwise filtered to one repo.
export function dmThreadFilter(agentId: string) {
  return sql`(${threads.type} = 'dm' AND ${threads.dmKey} IS NOT NULL AND ${agentId} = ANY(string_to_array(${threads.dmKey}, ':')))`;
}

// The events feed is repo-scoped, but a DM event carries the sender's repoId,
// so the recipient's own repo filter hides it. OR this into that filter.
export function dmEventFilter(agentId: string, targetType: SQL | AnyColumn, targetId: SQL | AnyColumn) {
  return sql`EXISTS (
    SELECT 1 FROM ${threads}
    WHERE ${threads.id} = ${targetId}
      AND ${targetType} = 'thread'
      AND ${threads.type} = 'dm'
      AND ${threads.dmKey} IS NOT NULL
      AND ${agentId} = ANY(string_to_array(${threads.dmKey}, ':'))
  )`;
}
