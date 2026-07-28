import { createDb } from "@getrelai/db";
import { sql } from "drizzle-orm";
import { TEST_DATABASE_URL } from "./test-db.js";

// Runs once before any test file, isolating the suite from whatever a prior
// crashed run or a forgotten per-test cleanup left behind — relai_test always
// starts empty, so hygiene never depends on every test author remembering to
// clean up (that discipline-based approach already failed twice on this repo).
export async function setup() {
  const db = createDb(TEST_DATABASE_URL);
  await db.execute(sql`TRUNCATE TABLE
    users, repos, agents, tokens, invites, threads, messages, tasks,
    subscriptions, notification_channels, verification_log, events, routing_log
  CASCADE`);
  await db.$client.end();
}
