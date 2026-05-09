import { input } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";
import { resolveAgentRef } from "../lib/resolve.js";
import { nonInteractive, requireFlag } from "../lib/interactive.js";

const VALID_TYPES = ["handoff", "finding", "decision", "question", "escalation", "status", "reply"] as const;
type MessageType = typeof VALID_TYPES[number];

export async function sendCommand(
  threadId: string,
  options: { message?: string; type?: string; to?: string }
) {
  const config = requireConfig();
  const client = new CliApiClient(config);
  const ni = nonInteractive();

  const type = (options.type ?? "status") as MessageType;
  if (!VALID_TYPES.includes(type)) {
    console.error(chalk.red(`Invalid message type "${type}". Must be one of: ${VALID_TYPES.join(", ")}.`));
    process.exit(1);
  }

  const body = options.message
    ?? (ni ? requireFlag("message body", "--message/-m") : await input({
      message: "Message (be specific — receiver has no other context)",
    }));

  if (!body.trim()) {
    console.error(chalk.red("Message body cannot be empty."));
    process.exit(1);
  }

  const toAgent = options.to
    ? await resolveAgentRef(client, config.projectId, options.to)
    : undefined;

  const spinner = ora("Sending...").start();

  try {
    const message = await client.sendMessage(threadId, {
      fromAgent: config.agentId,
      toAgent,
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
