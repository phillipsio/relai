# @ai-orchestrator/mcp-server

MCP server that AI agents connect to. Exposes 8 tools for task management and agent coordination. Compatible with Claude Code, GitHub Copilot, and any MCP-capable client.

## Tools

- `get_my_tasks` — fetch tasks assigned to this agent
- `update_task_status` — mark in_progress / completed / blocked
- `send_message` — post to a thread (handoff / finding / decision / question / escalation / status)
- `get_unread_messages` — check inbox
- `mark_thread_read` — mark a thread as read
- `list_threads` — see all project threads
- `create_thread` — start a new thread
- `list_all_tasks` — project-wide task view

## Required env vars

```
ORCHESTRATOR_API_URL      (default: http://localhost:3000)
ORCHESTRATOR_API_SECRET
AGENT_ID
PROJECT_ID
TRANSPORT                 (default: stdio — use "http" for remote)
```

See `../../docs/mcp-config.md` for full configuration examples for Claude Code, Copilot, and remote HTTP setups.
