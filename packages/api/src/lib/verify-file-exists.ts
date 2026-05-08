import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { VerificationResult } from "./verify.js";

/**
 * Structured `file_exists` verifier. Returns exit 0 on hit, 1 on miss — matches
 * the shape of {@link runVerification} so the scheduler can treat both kinds
 * uniformly. No shell exec, so this kind is safe to run inside a hosted
 * multi-tenant API.
 */
export async function runFileExistsVerification(
  path: string,
  cwd?: string | null,
): Promise<VerificationResult> {
  const start = Date.now();
  const target = resolve(cwd ?? process.cwd(), path);
  try {
    await access(target);
    return {
      exitCode:   0,
      stdout:     `${target}\n`,
      stderr:     "",
      durationMs: Date.now() - start,
      timedOut:   false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode:   1,
      stdout:     "",
      stderr:     `${target}: ${message}`,
      durationMs: Date.now() - start,
      timedOut:   false,
    };
  }
}
