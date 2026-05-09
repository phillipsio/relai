import type { VerificationResult } from "./verify.js";

export type ReviewDecision = {
  decision:   "approve" | "reject";
  reviewerId: string;
  decidedAt:  string;
  note?:      string;
};

/**
 * Structured `reviewer_agent` verifier. The decision is stored in
 * `task.metadata.review` by POST /tasks/:id/review; this function only
 * translates that record into a {@link VerificationResult}. The scheduler
 * is responsible for skipping rows whose decision hasn't landed yet — by
 * the time we get here, `review` is expected to be present.
 */
export function runReviewerAgentVerification(review: ReviewDecision): VerificationResult {
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
