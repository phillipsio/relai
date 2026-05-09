#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { tasksCommand, taskUpdateCommand, taskCreateCommand, taskReviewCommand } from "./commands/tasks.js";
import { projectsListCommand, projectShowCommand, projectContextShowCommand, projectContextEditCommand } from "./commands/projects.js";
import { agentsListCommand } from "./commands/agents.js";
import { threadsCommand, threadNewCommand } from "./commands/threads.js";
import { sendCommand } from "./commands/send.js";
import { inboxCommand } from "./commands/inbox.js";
import { statusCommand } from "./commands/status.js";
import { startCommand } from "./commands/start.js";
import { tokenRotateCommand, tokenRevokeCommand } from "./commands/token.js";
import { projectInviteCommand, loginCommand } from "./commands/invite.js";

const program = new Command();

program
  .name("relai")
  .description("ai-orchestrator CLI — coordinate agents from the terminal")
  .version("0.1.0")
  // Global non-interactive switch. When set (or when RELAI_NO_INPUT=1, or when
  // stdin isn't a TTY), commands fail fast on missing required input instead
  // of opening a prompt — making CLI usage scriptable.
  .option("--no-input", "Never prompt; require values via flags")
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts().input === false) process.env.RELAI_NO_INPUT = "1";
  });

// ── init ─────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Register this machine as an agent and save config to ~/.config/relai/config.json")
  .action(initCommand);

// ── status ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show your agent info, online agents, task summary, and unread count")
  .action(statusCommand);

program
  .command("start")
  .description("Show your session orientation: project context, your open tasks, unread messages, open threads")
  .action(startCommand);

// ── tasks ─────────────────────────────────────────────────────────────────────

program
  .command("tasks")
  .description("List tasks assigned to you (default: assigned + in_progress)")
  .option("-a, --all", "Show all tasks in the project, not just yours")
  .option("-s, --status <status>", "Filter by status (comma-separated: pending,assigned,in_progress,pending_verification,completed,blocked)")
  .action(tasksCommand);

// ── task subcommands ──────────────────────────────────────────────────────────

const task = program.command("task").description("Create or update a task");

task
  .command("create")
  .description("Create a new task")
  .option("-t, --title <title>", "Task title")
  .option("-d, --description <description>", "Task description")
  .option("-p, --priority <priority>", "low|normal|high|urgent")
  .option("--to <agent>", "Assign to an agent (id or name)")
  .option("--domains <list>", "Comma-separated domain tags")
  .option("--specialization <s>", "Required specialization")
  .option("-v, --verify <cmd>", "Shell command that must exit 0 to gate the `completed` transition")
  .option("--verify-cwd <path>", "Working directory for --verify (defaults to API server cwd)")
  .option("--verify-kind <kind>", "Verifier kind: shell|file_exists|thread_concluded|reviewer_agent")
  .option("--verify-path <path>", "Path that must exist (--verify-kind file_exists)")
  .option("--verify-thread <id>", "Thread that must be concluded (--verify-kind thread_concluded)")
  .option("--verify-reviewer <agent>", "Agent (id or name) who must approve (--verify-kind reviewer_agent)")
  .option("--review-by <agent>", "Shorthand for --verify-kind reviewer_agent --verify-reviewer <agent>")
  .action(taskCreateCommand);

task
  .command("start <id>")
  .description("Mark a task as in_progress")
  .option("-n, --note <note>", "Optional note to attach")
  .action((id, options) => taskUpdateCommand(id, "in_progress", options));

task
  .command("done <id>")
  .description("Mark a task as completed")
  .option("-n, --note <note>", "Optional note to attach")
  .action((id, options) => taskUpdateCommand(id, "completed", options));

task
  .command("block <id>")
  .description("Mark a task as blocked")
  .option("-n, --note <note>", "Describe what's blocking you")
  .action((id, options) => taskUpdateCommand(id, "blocked", options));

task
  .command("cancel <id>")
  .description("Mark a task as cancelled")
  .option("-n, --note <note>", "Optional reason")
  .action((id, options) => taskUpdateCommand(id, "cancelled", options));

task
  .command("review <id>")
  .description("Submit your review decision on a reviewer_agent-gated task (you must be the named reviewer)")
  .option("-d, --decision <decision>", "approve | reject")
  .option("-n, --note <note>", "Optional rationale (recommended on reject)")
  .action(taskReviewCommand);

// ── threads ───────────────────────────────────────────────────────────────────

program
  .command("threads")
  .description("List all threads for this project")
  .action(threadsCommand);

const thread = program.command("thread").description("Thread operations");

thread
  .command("new <title>")
  .description("Create a new thread")
  .action(threadNewCommand);

// ── messages ──────────────────────────────────────────────────────────────────

program
  .command("send <threadId>")
  .description("Send a message to a thread")
  .option("-m, --message <body>", "Message body (skips interactive prompt)")
  .option("-t, --type <type>", "Message type: status|handoff|finding|decision|question|escalation|reply")
  .option("--to <agentId>", "Address to a specific agent (default: orchestrator)")
  .action(sendCommand);

program
  .command("inbox")
  .description("Show unread messages")
  .option("-r, --read", "Mark all displayed messages as read")
  .action(inboxCommand);

// ── discovery ────────────────────────────────────────────────────────────────

program
  .command("projects")
  .description("List all projects on this server")
  .action(projectsListCommand);

program
  .command("agents")
  .description("List agents in the current project")
  .action(agentsListCommand);

// ── login ────────────────────────────────────────────────────────────────────

program
  .command("login")
  .description("Log in to a project on this machine using an invite code")
  .option("--invite <code>", "Invite code from `relai project invite`")
  .option("--api <url>", "API URL (skips prompt)")
  .action(loginCommand);

// ── project invite ───────────────────────────────────────────────────────────

const project = program.command("project").description("Project operations");

project
  .command("show [id]")
  .description("Show a project's details (defaults to the current project)")
  .action(projectShowCommand);

const projectContext = project.command("context").description("View or edit the project's pinned context (read by every agent on session start)");

projectContext
  .command("show")
  .description("Print the current pinned context")
  .action(projectContextShowCommand);

projectContext
  .command("edit")
  .description("Open the pinned context in $EDITOR")
  .action(projectContextEditCommand);

project
  .command("invite")
  .description("Create an invite code for another agent to join this project")
  .option("-n, --name <name>", "Suggested agent name (the new agent can override)")
  .option("-s, --specialization <s>", "Suggested specialization")
  .option("--ttl <seconds>", "Expiry in seconds (default: 7 days)")
  .action(projectInviteCommand);

// ── token ────────────────────────────────────────────────────────────────────

const token = program.command("token").description("Manage your agent's API tokens");

token
  .command("rotate")
  .description("Issue a new token for your agent and save it to config (old token remains valid until revoked)")
  .action(tokenRotateCommand);

token
  .command("revoke <tokenId>")
  .description("Revoke a specific token id")
  .action(tokenRevokeCommand);

program.parseAsync(process.argv);
