import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";

const TYPE_COLOR: Record<string, (s: string) => string> = {
  handoff:    chalk.cyan,
  finding:    chalk.magenta,
  decision:   chalk.green,
  question:   chalk.yellow,
  escalation: chalk.red,
  status:     chalk.dim,
  reply:      (s) => s,
};

export async function inboxCommand(options: { read?: boolean }) {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const spinner = ora("Checking inbox...").start();

  try {
    const messages = await client.getUnread(config.agentId);
    spinner.stop();

    if (messages.length === 0) {
      console.log(chalk.dim("Inbox empty."));
      return;
    }

    console.log();
    for (const msg of messages) {
      const colorType = TYPE_COLOR[msg.type] ?? ((s: string) => s);
      const date = new Date(msg.createdAt).toLocaleString();
      const preview = msg.body.length > 120 ? msg.body.slice(0, 120) + "…" : msg.body;

      console.log(`${colorType(msg.type.padEnd(11))}  ${chalk.dim(msg.id)}`);
      console.log(`  ${chalk.dim("from:")} ${msg.fromAgent}  ${chalk.dim("thread:")} ${msg.threadId}  ${chalk.dim(date)}`);
      console.log(`  ${preview}`);
      console.log();
    }

    console.log(chalk.dim(`${messages.length} unread message${messages.length === 1 ? "" : "s"}`));

    // Group by thread and mark all as read if --read flag passed
    if (options.read) {
      const threadIds = [...new Set(messages.map((m) => m.threadId))];
      const markSpinner = ora("Marking as read...").start();
      await Promise.all(threadIds.map((tid) => client.markRead(tid, config.agentId)));
      markSpinner.succeed(chalk.dim("Marked as read"));
    } else {
      console.log(chalk.dim("Run with --read to mark all as read."));
    }
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch inbox"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}
