// A scheduler branch that reports an unchanging condition on a fixed interval
// writes the same line forever: measured at 11,520/day for two stuck tasks.
const logged = new Set<string>();

export function logOnce(
  key: string,
  message: string,
  write: (m: string) => void = console.log,
): void {
  if (logged.has(key)) return;
  logged.add(key);
  write(message);
}

// Call when the condition clears, so a later recurrence is reported again.
export function resetLogOnce(key: string): void {
  logged.delete(key);
}
