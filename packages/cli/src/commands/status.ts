import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";

export async function statusCommand() {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const spinner = ora("Fetching project status...").start();

  try {
    const [agents, tasks, unread] = await Promise.all([
      client.getAgents(config.projectId),
      client.getTasks({ projectId: config.projectId }),
      client.getUnread(config.agentId, config.projectId),
    ]);
    spinner.stop();

    console.log();
    console.log(chalk.bold("You"));
    console.log(`  ${chalk.dim("name:")}    ${config.agentName}`);
    console.log(`  ${chalk.dim("id:")}      ${config.agentId}`);
    console.log(`  ${chalk.dim("project:")} ${config.projectId}`);
    console.log(`  ${chalk.dim("api:")}     ${config.apiUrl}`);

    console.log();
    console.log(chalk.bold("Agents online"));
    const now = Date.now();
    for (const agent of agents) {
      const age = now - new Date(agent.lastSeenAt).getTime();
      const online = age < 2 * 60 * 1000;
      const indicator = online ? chalk.green("●") : chalk.dim("○");
      const me = agent.id === config.agentId ? chalk.dim(" (you)") : "";
      console.log(`  ${indicator}  ${agent.name}${me}  ${chalk.dim(agent.role)}  ${chalk.dim(agent.domains.join(", "))}`);
    }

    console.log();
    console.log(chalk.bold("Task summary"));
    const byStatus = tasks.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {});
    for (const [status, count] of Object.entries(byStatus)) {
      console.log(`  ${status.padEnd(14)} ${count}`);
    }

    if (unread.length > 0) {
      console.log();
      console.log(chalk.yellow(`  ${unread.length} unread message${unread.length === 1 ? "" : "s"} — run \`relai inbox\``));
    }
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch status"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}
