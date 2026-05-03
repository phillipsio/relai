import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";

export async function threadsCommand() {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const spinner = ora("Fetching threads...").start();

  try {
    const threads = await client.listThreads(config.projectId);
    spinner.stop();

    if (threads.length === 0) {
      console.log(chalk.dim("No threads yet. Create one with `relai thread new <title>`."));
      return;
    }

    console.log();
    for (const thread of threads) {
      const date = new Date(thread.createdAt).toLocaleDateString();
      console.log(`${chalk.bold(thread.id)}  ${chalk.dim(date)}  ${thread.title}`);
    }
    console.log(chalk.dim(`\n${threads.length} thread${threads.length === 1 ? "" : "s"}`));
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch threads"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}

export async function threadNewCommand(title: string) {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const spinner = ora("Creating thread...").start();

  try {
    const thread = await client.createThread({ projectId: config.projectId, title });
    spinner.succeed(chalk.green(`Thread created: ${chalk.bold(thread.id)}`));
    console.log(chalk.dim(`  "${thread.title}"`));
  } catch (err) {
    spinner.fail(chalk.red("Failed to create thread"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}
