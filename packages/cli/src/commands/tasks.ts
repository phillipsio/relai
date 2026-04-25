import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";

const STATUS_COLOR: Record<string, (s: string) => string> = {
  pending:     chalk.dim,
  assigned:    chalk.cyan,
  in_progress: chalk.yellow,
  completed:   chalk.green,
  blocked:     chalk.red,
  cancelled:   chalk.dim,
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
    spinner.succeed(`${chalk.bold(id)} → ${STATUS_COLOR[status]?.(status) ?? status}`);
    console.log(chalk.dim(`  ${task.title}`));
  } catch (err) {
    spinner.fail(chalk.red("Update failed"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}
