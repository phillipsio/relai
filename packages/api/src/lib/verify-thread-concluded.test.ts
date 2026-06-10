import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, threads, repos } from "@getrelai/db";
import { eq } from "drizzle-orm";
import { runThreadConcludedVerification } from "./verify-thread-concluded.js";
import { newId } from "./id.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";

const db = createDb(DB_URL);
let repoId: string;

beforeAll(async () => {
  repoId = newId("repo");
  await db.insert(repos).values({ id: repoId, name: "__test__ tcv" });
});

afterAll(async () => {
  await db.delete(threads).where(eq(threads.repoId, repoId));
  await db.delete(repos).where(eq(repos.id, repoId));
});

describe("runThreadConcludedVerification", () => {
  it("exits 0 with the thread summary when status='concluded'", async () => {
    const id = newId("thread");
    await db.insert(threads).values({
      id, repoId, title: "t", status: "concluded", summary: "decision: ship it",
    });
    const r = await runThreadConcludedVerification(db, id);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ship it");
  });

  it("exits 1 when the thread is still open", async () => {
    const id = newId("thread");
    await db.insert(threads).values({ id, repoId, title: "t", status: "open" });
    const r = await runThreadConcludedVerification(db, id);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("open");
  });

  it("exits 1 when the thread doesn't exist", async () => {
    const r = await runThreadConcludedVerification(db, "thread_does_not_exist");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });
});
