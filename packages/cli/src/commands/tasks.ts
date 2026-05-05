import chalk from "chalk";
import ora from "ora";
import { input, select } from "@inquirer/prompts";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";
import { resolveAgentRef } from "../lib/resolve.js";

const STATUS_COLOR: Record<string, (s: string) => string> = {
  pending:              chalk.dim,
  assigned:             chalk.cyan,
  in_progress:          chalk.yellow,
  pending_verification: chalk.magenta,
  completed:            chalk.green,
  blocked:              chalk.red,
  cancelled:            chalk.dim,
};

const PRIORITY_COLOR: Record<string, (s: string) => string> = {
  low:    chalk.dim,
  normal: (s) => s,
  high:   chalk.yellow,
  urgent: chalk.red,
};

export async function tasksCommand(options: { all?: boolean; status?: string }) {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const spinner = ora("Fetching tasks...").start();

  try {
    const status = options.status ?? (options.all ? undefined : "assigned,in_progress");
    const tasks = await client.getTasks({
      projectId: config.projectId,
      assignedTo: options.all ? undefined : config.agentId,
      status,
    });
    spinner.stop();

    if (tasks.length === 0) {
      console.log(chalk.dim("No tasks found."));
      return;
    }

    console.log();
    for (const task of tasks) {
      const colorStatus = STATUS_COLOR[task.status] ?? ((s: string) => s);
      const colorPriority = PRIORITY_COLOR[task.priority] ?? ((s: string) => s);
      console.log(
        `${chalk.bold(task.id)}  ${colorStatus(task.status.padEnd(12))}  ${colorPriority(task.priority.padEnd(7))}  ${task.title}`
      );
      if (task.domains.length > 0) {
        console.log(chalk.dim(`             domains: ${task.domains.join(", ")}`));
      }
    }
    console.log(chalk.dim(`\n${tasks.length} task${tasks.length === 1 ? "" : "s"}`));
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch tasks"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}

export async function taskCreateCommand(options: {
  title?: string;
  description?: string;
  priority?: string;
  to?: string;
  domains?: string;
  specialization?: string;
  verify?: string;
  verifyCwd?: string;
}) {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const title = options.title ?? await input({ message: "Title" });
  if (!title.trim()) {
    console.error(chalk.red("Title is required."));
    process.exit(1);
  }

  const description = options.description ?? await input({ message: "Description" });
  if (!description.trim()) {
    console.error(chalk.red("Description is required."));
    process.exit(1);
  }

  const priority = (options.priority ?? await select({
    message: "Priority",
    choices: [
      { value: "normal", name: "normal" },
      { value: "low",    name: "low" },
      { value: "high",   name: "high" },
      { value: "urgent", name: "urgent" },
    ],
  })) as "low" | "normal" | "high" | "urgent";

  let assignedTo: string | undefined;
  if (options.to) {
    assignedTo = await resolveAgentRef(client, config.projectId, options.to);
  }

  const domains = options.domains
    ? options.domains.split(",").map((d) => d.trim()).filter(Boolean)
    : [];

  const spinner = ora("Creating task...").start();
  try {
    const task = await client.createTask({
      projectId:   config.projectId,
      createdBy:   config.agentId,
      title,
      description,
      priority,
      assignedTo,
      domains,
      specialization: options.specialization,
      verifyCommand: options.verify,
      verifyCwd:     options.verifyCwd,
    });
    spinner.succeed(chalk.green(`Created ${chalk.bold(task.id)}`));
    console.log(chalk.dim(`  ${task.title}`));
    if (assignedTo) console.log(chalk.dim(`  assigned: ${assignedTo}`));
    if (options.verify) console.log(chalk.dim(`  verify:   ${options.verify}`));
  } catch (err) {
    spinner.fail(chalk.red("Create failed"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}

export async function taskUpdateCommand(
  id: string,
  status: "in_progress" | "completed" | "blocked" | "cancelled",
  options: { note?: string }
) {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const spinner = ora(`Marking task ${status}...`).start();

  try {
    const task = await client.updateTask(id, {
      status,
      metadata: options.note ? { note: options.note } : undefined,
    });
    const actual = task.status;
    const colored = STATUS_COLOR[actual]?.(actual) ?? actual;
    spinner.succeed(`${chalk.bold(id)} → ${colored}`);
    console.log(chalk.dim(`  ${task.title}`));
    if (status === "completed" && actual === "pending_verification") {
      console.log(chalk.magenta(`  pending verification — scheduler will run the predicate shortly`));
    }
  } catch (err) {
    spinner.fail(chalk.red("Update failed"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}
