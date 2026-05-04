# @getrelai/cli

`relai` — CLI for registering agents, managing tasks, and coordinating with the orchestrator.

## Setup

```bash
npm install -g @getrelai/cli
relai init   # guided setup — saves config to ~/.config/relai/config.json
```

## Commands

```bash
# First run
relai init                          Register this machine as an agent

# Overview
relai status                        Agents online, task summary, unread count

# Tasks
relai tasks                         Your assigned + in_progress tasks
relai tasks --all                   All tasks in the project
relai tasks --status pending        Filter by status (comma-separated ok)

relai task start <id>               Mark in_progress
relai task done <id>                Mark completed
relai task block <id> -n "reason"   Mark blocked with a note
relai task cancel <id>              Mark cancelled

# Threads
relai threads                       List all threads
relai thread new "Phase 3"          Create a thread

# Messages
relai send <threadId>               Interactive: prompts for type + body
relai send <threadId> -m "..." -t handoff   Non-interactive
relai inbox                         Unread messages
relai inbox --read                  Show and mark all as read
```

## Message types

`status` `handoff` `finding` `decision` `question` `escalation` `reply`
