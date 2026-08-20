import { createDb } from "@getrelai/db";
import { sql } from "drizzle-orm";
import type { Db } from "@getrelai/db";
import { TEST_DATABASE_URL } from "./test-db.js";

// Every table in `public`, discovered at run time. It used to be a literal list,
// which silently rots: TRUNCATE ... CASCADE only reaches a new table if some
// listed table has a foreign key pointing at it, so a new root table survives
// between runs and the second `pnpm test` starts failing on unique constraints.
//
// Restricting to `public` also keeps `drizzle.__drizzle_migrations` out of it.
// Truncating that would make every migration re-run against an already-migrated
// database on the next `db:migrate`.
export async function truncatableTables(db: Db): Promise<string[]> {
  const rows = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);
  return [...rows].map((r) => r.tablename);
}

export async function setup() {
  const db = createDb(TEST_DATABASE_URL);
  const tables = await truncatableTables(db);
  if (tables.length > 0) {
    const list = tables.map((t) => `"${t}"`).join(", ");
    await db.execute(sql.raw(`TRUNCATE TABLE ${list} CASCADE`));
  }
  await db.$client.end();
}
