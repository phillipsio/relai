import chalk from "chalk";

/**
 * True when the CLI shouldn't prompt: explicit --no-input (which sets
 * RELAI_NO_INPUT=1 via a preAction hook), RELAI_NO_INPUT in the env, or
 * stdin not attached to a TTY (CI, piped input, headless harness).
 */
export function nonInteractive(): boolean {
  if (process.env.RELAI_NO_INPUT === "1") return true;
  return !process.stdin.isTTY;
}

/**
 * Bail out of a non-interactive run when a value the operator must supply
 * was omitted. Prints a one-line hint pointing at the right flag and exits 2.
 */
export function requireFlag(label: string, flagHint: string): never {
  console.error(chalk.red(`Missing ${label} (non-interactive mode).`));
  console.error(chalk.dim(`  Pass ${flagHint} or run interactively (TTY, no --no-input).`));
  process.exit(2);
}
