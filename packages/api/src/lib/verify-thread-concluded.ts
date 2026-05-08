import { eq } from "drizzle-orm";
import { threads, type Db } from "@getrelai/db";
import type { VerificationResult } from "./verify.js";

/**
 * Structured `thread_concluded` verifier. Passes (exit 0) when the referenced
 * thread's status is "concluded"; fails (exit 1) when it's still open or the
 * thread has been deleted. Same shape as {@link runVerification}.
 */
export async function runThreadConcludedVerification(
  db: Db,
  threadId: string,
): Promise<VerificationResult> {
  const start = Date.now();
  const [row] = await db
    .select({ status: threads.status, summary: threads.summary })
    .from(threads)
    .where(eq(threads.id, threadId));

  if (!row) {
    return {
      exitCode:   1,
      stdout:     "",
      stderr:     `thread ${threadId}: not found`,
      durationMs: Date.now() - start,
      timedOut:   false,
    };
  }
  if (row.status !== "concluded") {
    return {
      exitCode:   1,
      stdout:     "",
      stderr:     `thread ${threadId}: status="${row.status}" (expected "concluded")`,
      durationMs: Date.now() - start,
      timedOut:   false,
    };
  }
  return {
    exitCode:   0,
    stdout:     row.summary ?? "concluded",
    stderr:     "",
    durationMs: Date.now() - start,
    timedOut:   false,
  };
}
