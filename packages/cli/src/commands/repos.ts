import chalk from "chalk";
import ora from "ora";
import { editor } from "@inquirer/prompts";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";

export async function reposListCommand() {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const spinner = ora("Fetching projects...").start();
  try {
    const projects = await client.listRepos();
    spinner.stop();

    if (projects.length === 0) {
      console.log(chalk.dim("No projects."));
      return;
    }

    console.log();
    for (const p of projects) {
      const here = p.id === config.repoId ? chalk.green("●") : " ";
      console.log(`${here} ${chalk.bold(p.id)}  ${p.name}`);
      if (p.description) console.log(chalk.dim(`    ${p.description}`));
    }
    console.log();
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch projects"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}

export async function repoShowCommand(id?: string) {
  const config = requireConfig();
  const client = new CliApiClient(config);
  const repoId = id ?? config.repoId;

  const spinner = ora("Fetching project...").start();
  try {
    const [project, agents, tasks] = await Promise.all([
      client.getRepo(repoId),
      client.getAgents(repoId),
      client.getTasks({ repoId }),
    ]);
    spinner.stop();

    console.log();
    console.log(chalk.bold(project.name));
    console.log(chalk.dim(`  id:           ${project.id}`));
    if (project.description) console.log(chalk.dim(`  description:  ${project.description}`));
    if (project.repoUrl)     console.log(chalk.dim(`  repo:         ${project.repoUrl}`));
    if (project.defaultAssignee) console.log(chalk.dim(`  default to:   ${project.defaultAssignee}`));
    console.log(chalk.dim(`  agents:       ${agents.length}`));
    console.log(chalk.dim(`  tasks:        ${tasks.length}`));
    if (project.context) {
      console.log();
      console.log(chalk.bold("  context:"));
      for (const line of project.context.split("\n")) console.log(chalk.dim(`    ${line}`));
    }
    console.log();
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch project"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}

export async function repoContextShowCommand() {
  const config = requireConfig();
  const client = new CliApiClient(config);
  try {
    const project = await client.getRepo(config.repoId);
    if (!project.context) {
      console.log(chalk.dim("(no context set — use `relai repo context edit` to add some)"));
      return;
    }
    console.log(project.context);
  } catch (err) {
    console.error(chalk.red(`Failed: ${String(err)}`));
    process.exit(1);
  }
}

export async function repoContextEditCommand() {
  const config = requireConfig();
  const client = new CliApiClient(config);
  try {
    const project = await client.getRepo(config.repoId);
    const next = await editor({
      message: `Project context for ${project.name} — saved on quit`,
      default: project.context ?? "",
      waitForUseInput: false,
    });
    const trimmed = next.trim() === "" ? null : next;
    await client.updateRepo(config.repoId, { context: trimmed });
    console.log(chalk.green(trimmed ? "✓ Context saved" : "✓ Context cleared"));
  } catch (err) {
    console.error(chalk.red(`Failed: ${String(err)}`));
    process.exit(1);
  }
}
