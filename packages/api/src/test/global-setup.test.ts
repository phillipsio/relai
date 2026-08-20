import { describe, it, expect } from "vitest";
import { createDb } from "@getrelai/db";
import { truncatableTables } from "./global-setup.js";
import { TEST_DATABASE_URL } from "./test-db.js";

describe("the test-DB reset discovers its own table list", () => {
  it("covers every public table, so a new one cannot be missed", async () => {
    const db = createDb(TEST_DATABASE_URL);
    const tables = await truncatableTables(db);

    // A representative spread rather than a literal list: pinning all of them
    // would recreate the hardcoding this replaced.
    for (const t of ["repos", "agents", "tasks", "messages", "events"]) {
      expect(tables).toContain(t);
    }
    expect(tables.length).toBeGreaterThanOrEqual(13);
    await db.$client.end();
  });

  it("excludes the migration journal, which lives outside public", async () => {
    const db = createDb(TEST_DATABASE_URL);
    const tables = await truncatableTables(db);

    expect(tables).not.toContain("__drizzle_migrations");
    await db.$client.end();
  });
});
