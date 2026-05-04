import { input, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { requireConfig, writeConfig, readConfig, configPath } from "../config.js";
import { CliApiClient } from "../api.js";

const SPECIALIZATION_CHOICES = [
  { value: "writer",       name: "writer        — implementation, code changes" },
  { value: "reviewer",     name: "reviewer      — code review, PR feedback" },
  { value: "tester",       name: "tester        — testing, QA, coverage" },
  { value: "architect",    name: "architect     — system design, planning" },
  { value: "devops",       name: "devops        — CI/CD, infrastructure" },
  { value: "orchestrator", name: "orchestrator  — routes and coordinates other agents" },
  { value: "custom",       name: "custom        — define your own" },
];

export async function projectInviteCommand(opts: { name?: string; specialization?: string; ttl?: string }) {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const ttlSeconds = opts.ttl ? Number(opts.ttl) : undefined;
  if (opts.ttl && !Number.isFinite(ttlSeconds)) {
    console.error(chalk.red("--ttl must be a number of seconds"));
    process.exit(1);
  }

  const s = ora("Creating invite…").start();
  try {
    const { invite, code } = await client.createInvite(config.projectId, {
      suggestedName: opts.name,
      suggestedSpecialization: opts.specialization,
      ttlSeconds,
    });
    s.succeed(chalk.green("Invite created"));

    console.log(`
${chalk.bold("Send this to the new agent:")}

  ${chalk.cyan(`relai login --invite ${code}`)}

${chalk.dim("expires:")}     ${invite.expiresAt}
${chalk.dim("invite id:")}   ${invite.id}
${chalk.dim("api url:")}     ${config.apiUrl}
${chalk.yellow("Note:")} the code is single-use. If they need to re-run, generate a new invite.
`);
  } catch (err) {
    s.fail(chalk.red("Failed to create invite"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}

export async function loginCommand(opts: { invite?: string; api?: string }) {
  const existing = readConfig();
  if (existing) {
    console.log(chalk.yellow(`\nAlready logged in as ${chalk.bold(existing.agentName)} (${existing.agentId})`));
    console.log(chalk.dim("Delete ~/.config/relai/config.json to re-login.\n"));
    return;
  }

  if (!opts.invite) {
    console.error(chalk.red("relai login requires --invite <code>"));
    console.error(chalk.dim("Ask a project member to run `relai project invite` and share the code."));
    process.exit(1);
  }

  const apiUrl = opts.api ?? await input({ message: "API URL", default: "http://localhost:3010" });
  const client = new CliApiClient({ apiUrl });

  const name = await input({
    message: "Agent name",
    default: `${process.env.USER ?? "agent"}-claude-code`,
  });

  const specialization = await select({
    message: "Specialization",
    choices: SPECIALIZATION_CHOICES,
  });

  const role = specialization === "orchestrator" ? "orchestrator" : "worker";
  const specForApi = specialization === "custom" ? undefined : specialization;

  const s = ora("Accepting invite…").start();
  try {
    const { agent, token } = await client.acceptInvite({
      code: opts.invite,
      name,
      role,
      specialization: specForApi,
      workerType: "human",
    });

    writeConfig({
      apiUrl,
      apiToken: token,
      agentId: agent.id,
      agentName: agent.name,
      projectId: agent.projectId,
      specialization: specialization === "custom" ? undefined : specialization,
    });

    s.succeed(chalk.green("Logged in"));
    console.log(`
${chalk.bold("Agent")}
  name:           ${agent.name}
  id:             ${chalk.dim(agent.id)}
  project:        ${chalk.dim(agent.projectId)}

${chalk.bold("Config saved to")} ${chalk.dim(configPath())}

${chalk.bold("Add to your MCP config")} ${chalk.dim("(.mcp.json in your repo or ~/.claude.json):")}

${chalk.cyan(JSON.stringify({
  mcpServers: {
    relai: {
      command: "npx",
      args: ["@getrelai/mcp-server"],
      env: {
        API_URL:    apiUrl,
        API_SECRET: token,
        AGENT_ID:   agent.id,
        PROJECT_ID: agent.projectId,
      },
    },
  },
}, null, 2))}
`);
  } catch (err) {
    s.fail(chalk.red("Login failed"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}
