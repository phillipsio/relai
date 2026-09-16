import { sql } from "drizzle-orm";
import { messages, threads } from "@getrelai/db";
import { dmThreadFilter } from "./dm.js";

// Shared so the two unread surfaces cannot drift: they held the same three
// terms in two places and had to be widened for DMs one at a time. The message
// loop keeps its own repo-scoped copy deliberately; see the note there.
//
// The sender term excludes at query time rather than seeding readBy at insert,
// so it covers the rows already in the table with no backfill.
export function unreadFilter({ agentId, repoId }: { agentId: string; repoId: string }) {
  return sql`(${threads.repoId} = ${repoId} OR ${dmThreadFilter(agentId)})
    AND ${messages.fromAgent} <> ${agentId}
    AND NOT (${messages.readBy} @> ARRAY[${agentId}]::text[])`;
}
