import { sql } from "drizzle-orm";
import { tasks } from "@getrelai/db";
import { humanizeTaskStatus, DEFAULT_UNSTARTED_AFTER_MS } from "@getrelai/types";

// Read per call, not cached, so a test that sets it after import isn't ignored.
// Validated, not bare Number(): `UNSTARTED_AFTER_MS=` parses to 0, and every
// assigned task is then older than its threshold.
function unstartedAfterMs(): number {
  const n = Number(process.env.UNSTARTED_AFTER_MS);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_UNSTARTED_AFTER_MS;
}

export function taskLabel(task: Parameters<typeof humanizeTaskStatus>[0]) {
  return humanizeTaskStatus(task, { unstartedAfterMs: unstartedAfterMs() });
}

// An unstarted task has by definition the oldest updatedAt among open rows, so
// a plain `updated_at desc` sorts it last and the cap drops it first.
export function unstartedFirst() {
  // ISO string, not a Date: a raw sql`` param carries no column type, so the
  // driver cannot serialise one. Client clock, the same one taskLabel reads.
  const cutoff = new Date(Date.now() - unstartedAfterMs()).toISOString();
  return sql`case when ${tasks.status} = 'assigned' and ${tasks.updatedAt} < ${cutoff}::timestamptz then 0 else 1 end`;
}
