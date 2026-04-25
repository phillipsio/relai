# @ai-orchestrator/cli

`orch` — CLI for registering agents, managing tasks, and coordinating with the orchestrator.

## Setup

```bash
npm install -g @ai-orchestrator/cli
orch init   # guided setup — saves config to ~/.config/orch/config.json
```

## Commands

```bash
# First run
orch init                          Register this machine as an agent

# Overview
orch status                        Agents online, task summary, unread count

# Tasks
orch tasks                         Your assigned + in_progress tasks
orch tasks --all                   All tasks in the project
orch tasks --status pending        Filter by status (comma-separated ok)

orch task start <id>               Mark in_progress
orch task done <id>                Mark completed
orch task block <id> -n "reason"   Mark blocked with a note
orch task cancel <id>              Mark cancelled

# Threads
orch threads                       List all threads
orch thread new "Phase 3"          Create a thread

# Messages
orch send <threadId>               Interactive: prompts for type + body
orch send <threadId> -m "..." -t handoff   Non-interactive
orch inbox                         Unread messages
orch inbox --read                  Show and mark all as read
```

## Message types

`status` `handoff` `finding` `decision` `question` `escalation` `reply`
