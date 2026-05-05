import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";

const LABEL_COLOR: Record<string, (s: string) => string> = {
  "Running":         chalk.cyan,
  "Stalled":         chalk.red,
  "Starting":        chalk.blue,
  "Input required":  chalk.yellow,
  "Queued":          chalk.dim,
  "Unassigned":      chalk.dim,
  "Done":            chalk.green,
  "Cancelled":       chalk.dim,
};

export async function startCommand() {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const spinner = ora("Loading session...").start();
  let session;
  try {
    session = await client.getSessionStart(config.projectId);
  } catch (err) {
    spinner.fail(chalk.red("Failed to load session"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
  spinner.stop();

  console.log();
  console.log(chalk.bold(`${session.project.name}`) + chalk.dim(`  ${session.project.id}`));
  console.log(chalk.dim(`you: ${session.agent.name}${session.agent.specialization ? ` (${session.agent.specialization})` : ""}`));

  // Project context — the "everyone-reads-this" blob, surfaced first.
  if (session.project.context) {
    console.log();
    console.log(chalk.bold("Project context"));
    for (const line of session.project.context.split("\n")) {
      console.log(`  ${line}`);
    }
  }

  console.log();
  console.log(chalk.bold(`Your tasks (${session.tasks.length})`));
  if (session.tasks.length === 0) {
    console.log(chalk.dim("  none"));
  } else {
    for (const t of session.tasks) {
      const color = LABEL_COLOR[t.humanLabel] ?? chalk.white;
      console.log(`  ${color(t.humanLabel.padEnd(15))} ${t.title}  ${chalk.dim(t.id)}`);
    }
  }

  console.log();
  console.log(chalk.bold(`Unread messages (${session.unreadMessages.length})`));
  if (session.unreadMessages.length === 0) {
    console.log(chalk.dim("  none"));
  } else {
    for (const m of session.unreadMessages.slice(0, 5)) {
      const preview = m.body.replace(/\s+/g, " ").slice(0, 70);
      console.log(`  ${chalk.dim(m.type.padEnd(10))} ${preview}${m.body.length > 70 ? "…" : ""}`);
    }
    if (session.unreadMessages.length > 5) {
      console.log(chalk.dim(`  …and ${session.unreadMessages.length - 5} more — run \`relai inbox\``));
    }
  }

  console.log();
  console.log(chalk.bold(`Open threads (${session.openThreads.length})`));
  if (session.openThreads.length === 0) {
    console.log(chalk.dim("  none"));
  } else {
    for (const t of session.openThreads) {
      console.log(`  ${t.title}  ${chalk.dim(t.id)}`);
    }
  }

  console.log();
}
