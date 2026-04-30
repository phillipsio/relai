import { input, password, select, confirm } from "@inquirer/prompts";
import ora from "ora";
import chalk from "chalk";
import { writeConfig, readConfig, configPath } from "../config.js";
import { CliApiClient } from "../api.js";

const SPECIALIZATION_CHOICES = [
  { value: "orchestrator", name: "orchestrator  — routes and coordinates all agents" },
  { value: "architect",    name: "architect     — system design, technical planning, ADRs" },
  { value: "writer",       name: "writer        — implementation, code changes" },
  { value: "reviewer",     name: "reviewer      — code review, PR feedback, quality" },
  { value: "tester",       name: "tester        — testing, QA, coverage" },
  { value: "devops",       name: "devops        — CI/CD, infrastructure, deployments" },
  { value: "custom",       name: "custom        — define your own domains" },
];

const PRESET_DOMAINS: Record<string, string[]> = {
  orchestrator: [],
  architect:    ["architecture", "design", "system-design", "planning"],
  writer:       ["typescript", "react", "api", "implementation"],
  reviewer:     ["review", "code-quality", "pr"],
  tester:       ["testing", "qa", "e2e", "coverage"],
  devops:       ["ci", "infrastructure", "docker", "deployments"],
};

export async function initCommand() {
  const existing = readConfig();
  if (existing) {
    console.log(chalk.yellow(`\nAlready initialized as ${chalk.bold(existing.agentName)} (${existing.agentId})`));
    console.log(chalk.dim(`Delete ${configPath()} to re-run init.\n`));
    return;
  }

  console.log(chalk.bold("\norch init — register this agent\n"));

  // ── Connection ──────────────────────────────────────────────────────────────

  const apiUrl = await input({
    message: "API URL",
    default: "http://localhost:3010",
  });

  const apiSecret = await password({
    message: "API admin secret (used once to register; per-agent token is saved after)",
  });

  // Verify connection before proceeding. The bootstrap client uses the admin
  // secret; once the agent is registered we discard it and use the per-agent
  // token returned by POST /agents.
  const spinner = ora("Connecting to API…").start();
  const client = new CliApiClient({ apiUrl, apiToken: apiSecret });
  try {
    await client.heartbeat("_ping").catch(() => {}); // will 404 but proves connectivity + auth
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/health`, {
      headers: { Authorization: `Bearer ${apiSecret}` },
    });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    spinner.succeed(chalk.green("Connected"));
  } catch (err) {
    spinner.fail(chalk.red(`Cannot reach API: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // ── Project ─────────────────────────────────────────────────────────────────

  const createNew = await confirm({
    message: "Create a new project?",
    default: true,
  });

  let projectId: string;

  if (createNew) {
    const projectName = await input({ message: "Project name" });
    const s = ora("Creating project…").start();
    try {
      const project = await client.createProject({ name: projectName });
      projectId = project.id;
      s.succeed(chalk.green(`Project created: ${chalk.bold(project.name)}  ${chalk.dim(project.id)}`));
    } catch (err) {
      s.fail(chalk.red("Failed to create project"));
      console.error(chalk.dim(String(err)));
      process.exit(1);
    }
  } else {
    projectId = await input({ message: "Project ID" });
  }

  // ── Agent ───────────────────────────────────────────────────────────────────

  const agentName = await input({
    message: "Agent name",
    default: `${process.env.USER ?? "agent"}-claude-code`,
  });

  const specialization = await select({
    message: "Specialization",
    choices: SPECIALIZATION_CHOICES,
  });

  const role = specialization === "orchestrator" ? "orchestrator" : "worker";

  let domains: string[];
  if (specialization === "custom") {
    const raw = await input({
      message: "Domains (comma-separated, e.g. typescript,react)",
      default: "",
    });
    domains = raw.split(",").map((d) => d.trim()).filter(Boolean);
  } else {
    domains = PRESET_DOMAINS[specialization] ?? [];
    if (domains.length > 0) {
      console.log(chalk.dim(`  Domains: ${domains.join(", ")}`));
    }
  }

  // ── Register ─────────────────────────────────────────────────────────────────

  const s = ora("Registering agent…").start();
  try {
    const { agent, token } = await client.registerAgent({
      projectId, name: agentName, role,
      specialization: specialization !== "custom" ? specialization : undefined,
      domains,
    });

    writeConfig({ apiUrl, apiToken: token, agentId: agent.id, agentName: agent.name, projectId, specialization });
    s.succeed(chalk.green("Agent registered"));

    console.log(`
${chalk.bold("Agent")}
  name:           ${agent.name}
  id:             ${chalk.dim(agent.id)}
  specialization: ${specialization}
  role:           ${role}

${chalk.bold("Config saved to")} ${chalk.dim(configPath())}
${chalk.dim("(per-agent token stored — admin secret discarded)")}

${chalk.bold("Add to your Claude Code MCP config")} ${chalk.dim("(~/.claude/mcp.json or .mcp.json in your repo):")}

${chalk.cyan(JSON.stringify({
  mcpServers: {
    orch: {
      command: "npx",
      args: ["@relai/mcp-server"],
      env: {
        API_URL: apiUrl,
        API_SECRET: token,
        AGENT_ID: agent.id,
        PROJECT_ID: projectId,
      },
    },
  },
}, null, 2))}
`);
  } catch (err) {
    s.fail(chalk.red("Registration failed"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}
