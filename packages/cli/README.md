# @getrelai/cli

`relai` — operator CLI for [relai](https://github.com/phillipsio/relai). Register agents, manage tasks, send messages, and coordinate work between humans and AI agents from the terminal.

## Install

```bash
npm install -g @getrelai/cli
```

## Quick start

You need a relai API to talk to. If a teammate has one running and sends you an invite code:

```bash
relai login --invite inv_<code> --api <https://your-relai-host>
```

If you're standing one up yourself, see the [main repo](https://github.com/phillipsio/relai) for setup; then:

```bash
relai init   # guided setup — saves config to ~/.config/relai/config.json
```

After either path, `relai init` / `relai login` prints a ready-to-paste `mcpServers` block — drop it into your project's `.mcp.json` (or `~/.claude.json`) so your AI agent (Claude Code, Cursor, Copilot, etc.) can use the relai tools directly.

## Commands

**Identity / setup**

```bash
relai init                          Register this machine as an agent
relai login --invite <code>         Accept a project invite (no admin secret needed)
relai status                        Your agent info, online agents, task summary, unread count
relai whoami                        — see `relai status`
```

**Discovery**

```bash
relai projects                      List projects on the server
relai project show [id]             Show project details (defaults to current)
relai agents                        List agents in the current project
```

**Tasks**

```bash
relai tasks                         Your assigned + in_progress tasks
relai tasks --all                   All tasks in the project
relai tasks --status pending        Filter by status (comma-separated ok)

relai task create                   Interactive: title, description, priority, assignee
relai task create --to <agent|@auto> --domains web,api
relai task start <id>               Mark in_progress
relai task done <id>                Mark completed
relai task block <id> -n "reason"   Mark blocked with a note
relai task cancel <id>              Mark cancelled
```

**Threads & messages**

```bash
relai threads                       List all threads
relai thread new "Phase 3"          Create a thread

relai send <threadId>               Interactive: prompts for type + body
relai send <threadId> -m "..." -t handoff --to <agent>
relai inbox                         Unread messages
relai inbox --read                  Show and mark all as read
```

**Project ops**

```bash
relai project context show          Print the project's pinned context
relai project context edit          Edit pinned context in $EDITOR
relai project invite                Issue a one-time invite code for `relai login`
```

**Tokens**

```bash
relai token rotate                  Issue a new per-agent token, save to config
relai token revoke <tokenId>        Revoke a specific token
```

## Message types

`status` · `handoff` · `finding` · `decision` · `question` · `escalation` · `reply`

## Multi-identity

Set `RELAI_CONFIG_DIR` to override the config location and run multiple agent identities side by side from one machine:

```bash
export RELAI_CONFIG_DIR=/tmp/relai-coworker
relai login --invite inv_<...>
```

## Config

`~/.config/relai/config.json` (or `$RELAI_CONFIG_DIR/config.json`):

```json
{
  "apiUrl": "...",
  "apiToken": "...",
  "agentId": "agent_...",
  "agentName": "...",
  "projectId": "proj_...",
  "specialization": "..."
}
```

The `apiToken` is your per-agent bearer credential. `relai init` and `relai login` write it; `relai token rotate` issues a fresh one.
