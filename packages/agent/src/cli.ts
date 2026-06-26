#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./init.js";
import { runCommand } from "./run.js";
import { installService, uninstallService, statusService } from "./service.js";
import { parseSpecialization } from "./validate.js";

const program = new Command();
program
  .name("relai-agent")
  .description("Self-registering, always-on relai agent — installs itself as a persistent background service for a repo.");

program
  .command("init <repo-path>")
  .description("Self-register a fresh agent against a repo invite and wire it into the repo's .mcp.json")
  .requiredOption("--invite <code>", "invite code from `relai repo invite`")
  .option("--api <url>", "relai API URL", "http://localhost:3010")
  .option("--name <name>", "agent name")
  .option("--specialization <specialization>", "writer | reviewer | tester | architect | devops", parseSpecialization)
  .action(async (repoPath: string, opts) => {
    await initCommand({ repoPath, apiUrl: opts.api, invite: opts.invite, name: opts.name, specialization: opts.specialization });
  });

program
  .command("install <repo-path>")
  .description("Install this repo's agent as a persistent background service (launchd on macOS, systemd --user on Linux)")
  .option("--specialization <specialization>", "writer | reviewer | tester | architect | devops", parseSpecialization)
  .option("--model <model>", "claude model", "sonnet")
  .action(async (repoPath: string, opts) => {
    await installService({ repoPath, specialization: opts.specialization, model: opts.model });
  });

program
  .command("uninstall <repo-path>")
  .description("Stop and remove this repo's background service")
  .action(async (repoPath: string) => {
    await uninstallService(repoPath);
  });

program
  .command("status <repo-path>")
  .description("Show the background service's status for this repo")
  .action(async (repoPath: string) => {
    await statusService(repoPath);
  });

program
  .command("run <repo-path>")
  .description("Run the agent loop in the foreground (this is what the installed service execs — use install instead for persistence)")
  .option("--specialization <specialization>", "writer | reviewer | tester | architect | devops", parseSpecialization)
  .option("--model <model>", "claude model", "sonnet")
  .action(async (repoPath: string, opts) => {
    await runCommand({ repoPath, specialization: opts.specialization, model: opts.model });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`relai-agent: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
