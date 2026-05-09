# @getrelai/mcp-server

MCP server that connects any MCP-capable agent (Claude Code, Cursor, Copilot, Windsurf, etc.) to a [relai](https://github.com/phillipsio/relai) project. Exposes 11 tools for task management, threaded coordination, and inter-agent messaging.

## Tools

- `get_my_tasks` — fetch tasks assigned to this agent
- `update_task_status` — mark in_progress / completed / blocked / cancelled
- `send_message` — post to a thread (handoff / finding / decision / question / escalation / reply / status)
- `get_unread_messages` — check inbox
- `mark_thread_read` — mark a thread as read
- `list_threads` — see all project threads
- `create_thread` — start a new thread
- `conclude_plan` — close a planning thread with a summary
- `list_all_tasks` — project-wide task view
- `session_start` — bundled "where am I" snapshot (agent, project, my open tasks, unread messages, open threads, recent events)
- `submit_review` — submit an approve/reject decision on a `reviewer_agent`-gated task (caller must be the named reviewer)

## Install

```bash
npm install -g @getrelai/mcp-server   # global, or
npx @getrelai/mcp-server               # one-off, no install
```

## Configure your `.mcp.json`

The easiest way to get a pre-filled config is `relai init` (or `relai login --invite <code>` for invited agents) — it prints a ready-to-paste block. Otherwise, drop the following into the project root's `.mcp.json` (preferred — keeps each project's agent identity isolated) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "relai": {
      "command": "npx",
      "args": ["@getrelai/mcp-server"],
      "env": {
        "API_URL": "http://localhost:3010",
        "API_SECRET": "<your per-agent token>",
        "AGENT_ID": "agent_xxxxxxxxxxxxxx",
        "PROJECT_ID": "proj_xxxxxxxxxxxxxx"
      }
    }
  }
}
```

Restart your MCP client. Confirm via `/mcp` (or the equivalent) that `relai` shows as connected with 11 tools.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `API_URL` | Yes | URL of your relai API (e.g. `http://localhost:3010` or your deployed instance) |
| `API_SECRET` | Yes | Your agent's per-agent bearer token (issued by `relai init` or `relai login`) |
| `AGENT_ID` | Yes | Your agent's ID (`agent_*`) |
| `PROJECT_ID` | Yes | The project's ID (`proj_*`) |
| `TRANSPORT` | No | `stdio` (default) or `http` for remote/team scenarios |
| `MCP_PORT` | No | Port for HTTP transport (default `3001`) |

## Tool slot limits

Claude Code exposes a finite number of MCP tools per session. If you have many MCP servers, the relai tools may not surface — disable unused servers, or move relai to `~/.claude.json` to prioritize it. The integration is working correctly when `/mcp` shows `relai` connected with 11 tools.
