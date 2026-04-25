#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { tasksCommand, taskUpdateCommand } from "./commands/tasks.js";
import { threadsCommand, threadNewCommand } from "./commands/threads.js";
import { sendCommand } from "./commands/send.js";
import { inboxCommand } from "./commands/inbox.js";
import { statusCommand } from "./commands/status.js";

const program = new Command();

program
  .name("orch")
  .description("ai-orchestrator CLI — coordinate agents from the terminal")
  .version("0.1.0");

// ── init ─────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Register this machine as an agent and save config to ~/.config/orch/config.json")
  .action(initCommand);

// ── status ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show your agent info, online agents, task summary, and unread count")
  .action(statusCommand);

// ── tasks ─────────────────────────────────────────────────────────────────────

program
  .command("tasks")
  .description("List tasks assigned to you (default: assigned + in_progress)")
  .option("-a, --all", "Show all tasks in the project, not just yours")
  .option("-s, --status <status>", "Filter by status (comma-separated: pending,assigned,in_progress,completed,blocked)")
  .action(tasksCommand);

// ── task subcommands ──────────────────────────────────────────────────────────

const task = program.command("task").description("Update a task's status");

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

program.parseAsync(process.argv);
