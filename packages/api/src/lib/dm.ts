import { eq, sql } from "drizzle-orm";
import { threads, type Db } from "@getrelai/db";
import { newId } from "./id.js";

// An unordered pair: alice→bob and bob→alice must resolve to one conversation,
// so the key is sorted before it is stored or looked up.
export function dmKeyFor(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export function isDmParticipant(thread: { type: string | null; dmKey: string | null }, agentId: string): boolean {
  if (thread.type !== "dm" || !thread.dmKey) return false;
  return thread.dmKey.split(":").includes(agentId);
}

// The thread row needs a repo for its FK, and the sender's is the only one it
// can be sure of. It is deliberately NOT the access boundary: `dmKey` is, which
// is what lets the conversation cross repos and keeps a repo-mate out of it.
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

// Messages in DM threads this agent is part of, wherever those threads live.
// Callers AND this into a repo-scoped predicate with OR, so a cross-repo DM
// reaches an inbox that is otherwise filtered to one repo.
export function dmThreadFilter(agentId: string) {
  return sql`(${threads.type} = 'dm' AND ${threads.dmKey} IS NOT NULL AND ${agentId} = ANY(string_to_array(${threads.dmKey}, ':')))`;
}
