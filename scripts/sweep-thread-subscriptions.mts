#!/usr/bin/env tsx
// Remove `subscriptions` rows on a thread the subscriber has no business
// receiving. Dry run by default; pass --apply to delete.
//
// WHY THIS EXISTS. Until 2026-09-17 a task's `threadId` was writable and
// unvalidated, so a member could point its own task at a thread in another
// project (or at someone else's DM), and `POST /tasks/:id/comments` would then
// call ensureSubscription(agent, "thread", <that thread>). The pointer is fixed
// now; the rows it created are not, and they outlive it. resolveSubscribers
// matches on targetType+targetId with NO repo predicate, so every later
// message.posted on that thread reaches the holder's GET /events stream with
// payload.message.body in full, and selectChannels resolves webhook/Slack
// targets through the same subscriber list.
//
// THE OBVIOUS PREDICATE IS WRONG, which is why this is a script and not one
// DELETE. "The thread's repo differs from the agent's repo" deletes LEGITIMATE
// rows: a DM lives in the sender's repo, both participants are subscribed, and
// a DM is designed to cross repos, so the non-sender's row matches that
// predicate and is correct. The rule is per type:
//
//   type = 'dm'  -> keep iff the agent is one of the two named in dm_key
//   otherwise    -> keep iff thread.repo_id = agent.repo_id
//
// Also swept: rows whose thread no longer exists.
//
// Nothing legitimate creates what this deletes. POST /subscriptions resolves the
// target and refuses a cross-repo one; ensureSubscription is the server-side
// exception, but its only cross-repo case is a TASK target (POST /relai-feedback
// subscribing a reporter), which is why this is scoped to target_type='thread'
// and leaves task targets alone.
//
// Run it with the workspace's own tsx, the way every other script here resolves
// it (never `npx tsx`, which resolves nothing on a clean install):
//   DATABASE_URL=… packages/api/node_modules/.bin/tsx scripts/sweep-thread-subscriptions.mts
//   …same, plus --apply, to delete
// On the VPS, DATABASE_URL lives in /etc/relai/api.env.
// Relative, not by package name: the repo root has no dependency on the
// workspace packages, so a bare specifier does not resolve from scripts/. Same
// reason attention-check.mts reaches into packages/ by path.
import { createDb } from "../shared/db/src/index.js";

const apply = process.argv.includes("--apply");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required. On the VPS it lives in /etc/relai/api.env.");
  process.exit(2);
}

const db = createDb(url);

type Row = {
  id: string; agent_id: string; agent_repo: string;
  thread_id: string; thread_repo: string | null;
  thread_type: string | null; thread_title: string | null; reason: string;
};

// One query feeds both the dry run and the delete, so they can never disagree
// about which rows they mean.
const doomed = (await db.$client.unsafe<Row[]>(`
  SELECT s.id, s.agent_id, a.repo_id AS agent_repo,
         s.target_id AS thread_id, t.repo_id AS thread_repo,
         t.type AS thread_type, t.title AS thread_title,
         CASE
           WHEN t.id IS NULL THEN 'thread no longer exists'
           WHEN t.type = 'dm' THEN 'DM the agent is not a participant in'
           ELSE 'thread in another project'
         END AS reason
    FROM subscriptions s
    JOIN agents a ON a.id = s.agent_id
    LEFT JOIN threads t ON t.id = s.target_id
   WHERE s.target_type = 'thread'
     AND (
           t.id IS NULL
        OR (t.type = 'dm' AND position(a.id IN COALESCE(t.dm_key, '')) = 0)
        OR (COALESCE(t.type, '') <> 'dm' AND t.repo_id <> a.repo_id)
     )
   ORDER BY s.agent_id, s.target_id
`)) as unknown as Row[];

const [{ n }] = (await db.$client.unsafe<{ n: number }[]>(
  `SELECT count(*)::int AS n FROM subscriptions WHERE target_type = 'thread'`,
)) as unknown as { n: number }[];
console.log(`thread subscriptions: ${n} total, ${doomed.length} to remove\n`);

if (doomed.length === 0) {
  console.log("Nothing to do.");
  await db.$client.end();
  process.exit(0);
}

for (const r of doomed) {
  console.log(`  ${r.id}`);
  console.log(`    agent  ${r.agent_id} (repo ${r.agent_repo})`);
  console.log(`    thread ${r.thread_id} (repo ${r.thread_repo ?? "-"}, type ${r.thread_type ?? "-"}) ${r.thread_title ?? ""}`);
  console.log(`    reason ${r.reason}`);
}

if (!apply) {
  console.log(`\nDRY RUN. Re-run with --apply to delete these ${doomed.length} rows.`);
  await db.$client.end();
  process.exit(0);
}

// Delete the ids just printed rather than re-running the predicate: what the
// operator read is exactly what goes.
const ids = doomed.map((r) => r.id);
const deleted = (await db.$client.unsafe<{ id: string }[]>(
  `DELETE FROM subscriptions WHERE id = ANY($1) RETURNING id`,
  [ids],
)) as unknown as { id: string }[];
console.log(`\nDeleted ${deleted.length} of ${ids.length}.`);
await db.$client.end();
process.exit(deleted.length === ids.length ? 0 : 1);
