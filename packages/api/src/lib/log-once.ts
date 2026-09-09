// A scheduler branch that reports an unchanging condition on a fixed interval
// writes the same line forever: measured at 11,520/day for two stuck tasks.
const logged = new Set<string>();

export function logOnce(key: string, message: string): void {
  if (logged.has(key)) return;
  logged.add(key);
  console.log(message);
}

// Call when the condition clears, so a later recurrence is reported again.
export function resetLogOnce(key: string): void {
  logged.delete(key);
}

// Tests only: the set is process-global, so cases that assert on log volume
// would otherwise depend on which ran first.
export function clearLogOnceState(): void {
  logged.clear();
}
