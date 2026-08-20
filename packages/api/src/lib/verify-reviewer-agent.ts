import type { VerificationResult } from "./verify.js";

export type ReviewDecision = {
  decision:   "approve" | "reject";
  reviewerId: string;
  decidedAt:  string;
  note?:      string;
};

/**
 * Structured `reviewer_agent` verifier. Translates the decision stored in
 * `task.metadata.review` into a {@link VerificationResult}, and refuses any
 * decision that does not name the task's own `verifyReviewerId` — metadata is
 * client-writable, so the recorded reviewer has to be checked here rather than
 * trusted from whoever wrote the row.
 */
export function runReviewerAgentVerification(
  review: ReviewDecision | undefined,
  expectedReviewerId: string | null,
): VerificationResult {
  const fail = (reason: string): VerificationResult => ({
    exitCode: 1, stdout: "", stderr: reason, durationMs: 0, timedOut: false,
  });

  if (!review) return fail("no review decision recorded");
  // POST /tasks/:id/review is not the only writer of metadata.review, so the
  // decision is only worth anything if it names the task's own reviewer.
  if (!expectedReviewerId || review.reviewerId !== expectedReviewerId) {
    return fail(`review decision is not from the task's reviewer (expected ${expectedReviewerId ?? "none"}, got ${review.reviewerId})`);
  }

  if (review.decision === "approve") {
    return {
      exitCode:   0,
      stdout:     `approved by ${review.reviewerId}${review.note ? `: ${review.note}` : ""}`,
      stderr:     "",
      durationMs: 0,
      timedOut:   false,
    };
  }
  return {
    exitCode:   1,
    stdout:     "",
    stderr:     `rejected by ${review.reviewerId}${review.note ? `: ${review.note}` : ""}`,
    durationMs: 0,
    timedOut:   false,
  };
}
