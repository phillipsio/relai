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
    const [messages, pendingTasks, proposedTasks, agents] = await Promise.all([
      client.getUnread(config.agentId, config.repoId),
      client.getTasks({ repoId: config.repoId, status: "pending_verification" }),
      client.getTasks({ repoId: config.repoId, status: "proposed" }),
      client.getAgents(config.repoId),
    ]);
    spinner.stop();

    const pendingReviews = pendingTasks.filter((t) =>
      t.verifyKind === "reviewer_agent" && t.verifyReviewerId === config.agentId,
    );

    // Proposals awaiting commit are only actionable by orchestrators.
    const isOrchestrator = agents.some((a) => a.id === config.agentId && a.role === "orchestrator");
    const proposals = isOrchestrator ? proposedTasks : [];

    if (messages.length === 0 && pendingReviews.length === 0 && proposals.length === 0) {
      console.log(chalk.dim("Inbox empty."));
      return;
    }

    if (proposals.length > 0) {
      console.log();
      console.log(chalk.bold.blue(`Proposals awaiting commit (${proposals.length})`));
      for (const task of proposals) {
        const date = new Date(task.createdAt).toLocaleString();
        const titlePreview = task.title.length > 80 ? task.title.slice(0, 80) + "…" : task.title;
        const suggested = (task.metadata?.proposal as { suggestedAssignee?: string } | undefined)?.suggestedAssignee;
        console.log(`  ${chalk.blue("proposed")}  ${chalk.dim(task.id)}`);
        console.log(`  ${chalk.dim("suggests:")} ${suggested ?? "—"}  ${chalk.dim(date)}`);
        console.log(`  ${titlePreview}`);
        console.log(`  ${chalk.dim(`relai task commit ${task.id} --to <agent|@auto>  (or --reject)`)}`);
        console.log();
      }
    }

    if (pendingReviews.length > 0) {
      console.log();
      console.log(chalk.bold.yellow(`Pending reviews (${pendingReviews.length})`));
      for (const task of pendingReviews) {
        const date = new Date(task.updatedAt).toLocaleString();
        const titlePreview = task.title.length > 80 ? task.title.slice(0, 80) + "…" : task.title;
        console.log(`  ${chalk.yellow("review")}     ${chalk.dim(task.id)}`);
        console.log(`  ${chalk.dim("from:")} ${task.assignedTo ?? "?"}  ${chalk.dim(date)}`);
        console.log(`  ${titlePreview}`);
        console.log(`  ${chalk.dim(`relai task review ${task.id} --decision approve|reject`)}`);
        console.log();
      }
    }

    if (messages.length === 0) {
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
