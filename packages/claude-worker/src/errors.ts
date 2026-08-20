// Three classes because they need different remedies: only "credentials" is
// fixed by waiting. See AGENTS.md → Worker session-failure classification.
export type SessionFailure = "credentials" | "overflow" | "transient";

const CREDENTIAL_PATTERNS: RegExp[] = [
  /credit balance is too low/i,
  /insufficient[ _-]?credits?/i,
  /invalid[ _-]?(api[ _-]?key|x-api-key|bearer token)/i,
  /authentication[ _-]?error/i,
  /\bunauthorized\b/i,
  /\boauth token has expired\b/i,
  /please run\b[^\n]*\/login/i,
];

const OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /input length and .{0,40}exceed/i,
  /\bcontext_window_exceeded\b/i,
  /request too large/i,
];

export function classifySessionError(text: string): SessionFailure {
  if (!text) return "transient";
  // Credentials outrank overflow: a bad credential breaks every task.
  if (CREDENTIAL_PATTERNS.some((re) => re.test(text))) return "credentials";
  if (OVERFLOW_PATTERNS.some((re) => re.test(text))) return "overflow";
  return "transient";
}
