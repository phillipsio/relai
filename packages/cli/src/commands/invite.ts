import { resolve as resolvePath } from "node:path";
import { input, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { requireConfig, writeConfig, readConfig, configPath } from "../config.js";
import { CliApiClient } from "../api.js";
import { getGitRoot, getOriginUrl, normalizeRepoUrl, repoNameFromUrl } from "../lib/repo.js";
import {
  claimWorkingDir,
  hashToken,
  WorkingDirCollisionError,
} from "../lib/agents-state.js";

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

export async function loginCommand(opts: {
  invite?: string;
  api?: string;
  token?: string;
  workingDir?: string;
}) {
  if (opts.invite && opts.token) {
    console.error(chalk.red("Pass either --invite or --token, not both"));
    process.exit(1);
  }
  if (!opts.invite && !opts.token) {
    console.error(chalk.red("relai login requires --invite <code> or --token <token>"));
    console.error(chalk.dim("Ask a project member to run `relai project invite` and share the code, or create an agent in the cloud dashboard."));
    process.exit(1);
  }

  const existing = readConfig();
  if (existing && opts.invite) {
    console.log(chalk.yellow(`\nAlready logged in as ${chalk.bold(existing.agentName)} (${existing.agentId})`));
    console.log(chalk.dim("Delete ~/.config/relai/config.json to re-login.\n"));
    return;
  }

  const apiUrl = opts.api ?? await input({ message: "API URL", default: "http://localhost:3010" });

  let agentId: string;
  let agentName: string;
  let projectId: string;
  let agentSpecialization: string | undefined;
  let token: string;

  if (opts.token) {
    const s = ora("Authenticating…").start();
    try {
      const authedClient = new CliApiClient({ apiUrl, apiToken: opts.token });
      const session = await authedClient.getSessionStart();
      agentId = session.agent.id;
      agentName = session.agent.name;
      projectId = session.project.id;
      agentSpecialization = session.agent.specialization ?? undefined;
      token = opts.token;
      s.succeed(chalk.green(`Authenticated as ${agentName}`));
    } catch (err) {
      s.fail(chalk.red("Authentication failed"));
      console.error(chalk.dim(String(err)));
      process.exit(1);
    }
  } else {
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
      const result = await client.acceptInvite({
        code: opts.invite!,
        name,
        role,
        specialization: specForApi,
        workerType: "human",
      });
      agentId = result.agent.id;
      agentName = result.agent.name;
      projectId = result.agent.projectId;
      agentSpecialization = specialization === "custom" ? undefined : specialization;
      token = result.token;
      s.succeed(chalk.green("Logged in"));
    } catch (err) {
      s.fail(chalk.red("Login failed"));
      console.error(chalk.dim(String(err)));
      process.exit(1);
    }
  }

  // ── Validate working directory against the project repo ─────────────────────
  const requestedDir = resolvePath(opts.workingDir ?? process.cwd());
  let workingDir = requestedDir;

  const authedClient = new CliApiClient({ apiUrl, apiToken: token });
  let repoUrl: string | null = null;
  try {
    const project = await authedClient.getProject(projectId);
    repoUrl = project.repoUrl ?? null;
  } catch (err) {
    console.error(chalk.red("Could not load project to validate working directory"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }

  if (repoUrl) {
    const gitRoot = getGitRoot(requestedDir);
    if (!gitRoot) {
      const repoName = repoNameFromUrl(repoUrl);
      console.error(chalk.red(`Not in a git repo. Clone first:`));
      console.error(`  git clone ${repoUrl}`);
      console.error(`  cd ${repoName}`);
      console.error(`  relai login …`);
      process.exit(1);
    }
    const origin = getOriginUrl(gitRoot);
    if (origin && normalizeRepoUrl(origin) !== normalizeRepoUrl(repoUrl)) {
      console.error(
        chalk.red(`You're in ${origin}, but this agent is for ${repoUrl}.`),
      );
      console.error(
        `cd into a clone of ${repoUrl}, or pass ${chalk.cyan("--working-dir <path>")}.`,
      );
      process.exit(1);
    }
    workingDir = gitRoot;
  }

  try {
    claimWorkingDir({
      agentId,
      agentName,
      workingDir,
      apiUrl,
      tokenRef: hashToken(token),
    });
  } catch (err) {
    if (err instanceof WorkingDirCollisionError) {
      const repoName = repoUrl ? repoNameFromUrl(repoUrl) : "repo";
      const slug = agentName.replace(/[^a-zA-Z0-9._-]+/g, "-");
      console.error(
        chalk.red(
          `Agent ${err.existing.agentName} (${err.existing.agentId}) is already using ${err.existing.workingDir}.`,
        ),
      );
      console.error("Use a separate worktree for this agent:");
      console.error(`  git worktree add ../${repoName}-${slug}`);
      console.error(`  cd ../${repoName}-${slug}`);
      console.error(`  relai login …`);
      process.exit(1);
    }
    throw err;
  }

  writeConfig({
    apiUrl,
    apiToken: token,
    agentId,
    agentName,
    projectId,
    specialization: agentSpecialization,
  });

  const agent = { id: agentId, name: agentName, projectId };
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
}
