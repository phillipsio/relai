import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";

export async function projectsListCommand() {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const spinner = ora("Fetching projects...").start();
  try {
    const projects = await client.listProjects();
    spinner.stop();

    if (projects.length === 0) {
      console.log(chalk.dim("No projects."));
      return;
    }

    console.log();
    for (const p of projects) {
      const here = p.id === config.projectId ? chalk.green("●") : " ";
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

export async function projectShowCommand(id?: string) {
  const config = requireConfig();
  const client = new CliApiClient(config);
  const projectId = id ?? config.projectId;

  const spinner = ora("Fetching project...").start();
  try {
    const [project, agents, tasks] = await Promise.all([
      client.getProject(projectId),
      client.getAgents(projectId),
      client.getTasks({ projectId }),
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
    console.log();
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch project"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}
