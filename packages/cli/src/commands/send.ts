import { input, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";

const MESSAGE_TYPES = [
  { value: "handoff",    name: "handoff    — finished a task, passing context to next agent" },
  { value: "finding",    name: "finding    — discovered something relevant to other work" },
  { value: "decision",   name: "decision   — agreed-upon decision all agents should honor" },
  { value: "question",   name: "question   — blocked, need input before proceeding" },
  { value: "escalation", name: "escalation — needs human judgment" },
  { value: "status",     name: "status     — routine progress update" },
  { value: "reply",      name: "reply      — response to another message" },
];

export async function sendCommand(
  threadId: string,
  options: { message?: string; type?: string; to?: string }
) {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const type = options.type ?? await select({
    message: "Message type",
    choices: MESSAGE_TYPES,
  });

  const body = options.message ?? await input({
    message: "Message (be specific — receiver has no other context)",
  });

  if (!body.trim()) {
    console.error(chalk.red("Message body cannot be empty."));
    process.exit(1);
  }

  const spinner = ora("Sending...").start();

  try {
    const message = await client.sendMessage(threadId, {
      fromAgent: config.agentId,
      toAgent: options.to,
      type,
      body,
    });
    spinner.succeed(chalk.green(`Sent (${message.id})`));
    console.log(chalk.dim(`  thread: ${threadId}  type: ${type}`));
  } catch (err) {
    spinner.fail(chalk.red("Send failed"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}
