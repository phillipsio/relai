// Classify a worker session's failure text as fatal vs transient.
//
// Fatal = a credential/credit problem that re-spawning a fresh session within
// seconds will NOT resolve (it just burns a tight loop). The worker should back
// off hard and let a human fix the underlying issue. Transient errors (rate
// limits, overload, network blips) are expected to clear on their own, so the
// normal poll cadence is fine.
const FATAL_PATTERNS: RegExp[] = [
  /credit balance is too low/i,
  /insufficient[ _-]?credits?/i,
  /invalid[ _-]?(api[ _-]?key|x-api-key|bearer token)/i,
  /authentication[ _-]?error/i,
  /\bunauthorized\b/i,
  /\boauth token has expired\b/i,
  /please run\b[^\n]*\/login/i,
];

export function isFatalError(text: string): boolean {
  if (!text) return false;
  return FATAL_PATTERNS.some((re) => re.test(text));
}
