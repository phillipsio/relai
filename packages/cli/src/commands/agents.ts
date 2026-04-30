import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";

export async function agentsListCommand() {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const spinner = ora("Fetching agents...").start();
  try {
    const agents = await client.getAgents(config.projectId);
    spinner.stop();

    if (agents.length === 0) {
      console.log(chalk.dim("No agents in this project."));
      return;
    }

    console.log();
    const now = Date.now();
    for (const a of agents) {
      const age = now - new Date(a.lastSeenAt).getTime();
      const online = age < 2 * 60 * 1000;
      const indicator = online ? chalk.green("●") : chalk.dim("○");
      const me = a.id === config.agentId ? chalk.dim(" (you)") : "";
      const spec = a.specialization ?? a.role;
      console.log(`${indicator} ${chalk.bold(a.id)}  ${a.name}${me}  ${chalk.dim(spec)}`);
      if (a.domains.length > 0) {
        console.log(chalk.dim(`    domains: ${a.domains.join(", ")}`));
      }
    }
    console.log();
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch agents"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}
