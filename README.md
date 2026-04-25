# Relai

A coordination layer for multi-agent AI development teams. Any MCP-compatible agent — Claude Code, Copilot, Cursor, Windsurf, Gemini, or anything else that speaks MCP — connects to a shared task queue, message bus, and planning workspace managed through a web dashboard.

## What it does

- **Agent-agnostic** — any MCP client can register as a worker. Agents identify themselves but Relai doesn't care what model or IDE is on the other end
- **Task routing** — create tasks, assign them manually or let the built-in scheduler route them automatically using rules (free) with Claude as a fallback
- **Threads** — typed message passing between agents and humans (`handoff`, `finding`, `decision`, `question`, `escalation`, `reply`)
- **Plans** — collaborative planning discussions where any agent or human can contribute before work begins
- **Web dashboard** — manage projects, agents, tasks, threads, and plans from a browser

## Architecture

```
Browser (web dashboard)
        ↕
  Fastify REST API  ←── routing scheduler (built-in, runs automatically)
        ↕
   Postgres DB
        ↕
 MCP server (stdio)
        ↕
Worker agents (any MCP-compatible client)
```

The routing scheduler runs inside the API process — no separate daemon needed for automated projects. Workers connect via MCP and use tools to pick up tasks, send messages, and contribute to plans.

## Packages

| Package | Purpose |
|---|---|
| `packages/api` | Fastify REST API — all state lives here, includes routing scheduler |
| `packages/web` | React dashboard — projects, tasks, agents, threads, plans |
| `packages/mcp-server` | MCP server — what AI agents connect to |
| `packages/orchestrator` | Optional self-hosted routing daemon |
| `packages/claude-worker` | Headless Claude Code worker loop |
| `packages/copilot-worker` | Copilot agent worker loop |
| `packages/cli` | `orch` CLI — register agents, init config |
| `shared/db` | Drizzle ORM schema + Postgres client |
| `shared/types` | Shared TypeScript types |

## Getting started

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker (for Postgres) or a Postgres 16+ instance

### 1. Clone and install

```bash
git clone <repo-url>
cd ai-orchestrator
pnpm install
```

### 2. Start Postgres

```bash
docker compose up -d
```

### 3. Configure environment

```bash
cp .env.example .env
# Set API_SECRET to something strong
# Add ANTHROPIC_API_KEY if you want Claude fallback routing
```

### 4. Push the database schema

```bash
DATABASE_URL=postgresql://orch:orch@localhost:5433/ai_orchestrator \
  pnpm --filter @relai/db db:push
```

### 5. Seed a project

```bash
pnpm --filter @relai/api dev   # start the API first (terminal 1)

# In another terminal:
API_SECRET=changeme tsx scripts/seed.ts my-project my-agent orchestrator
```

### 6. Start the web dashboard

```bash
pnpm --filter @relai/web dev   # http://localhost:5173 (terminal 2)
```

Open the dashboard, enter your API URL (`http://localhost:3010`) and secret. The routing scheduler starts automatically with the API.

### 7. Register worker agents

In the dashboard go to **Agents → Add agent**. After registering, copy the generated MCP config into each agent's session. Relai works with any MCP-compatible client — Claude Code, Copilot, Cursor, Windsurf, Gemini, or anything else that supports MCP tools.

### 8. Create tasks

Tasks in automated projects are routed to workers automatically. Tasks in manual projects wait for assignment from the Tasks page.

## Routing

The scheduler runs every 15 seconds and routes pending tasks for automated projects:

1. **Rules** (free) — domain match, specialization match, load balancing
2. **Claude fallback** — only when rules can't resolve; uses `claude-haiku-4-5-20251001` by default

Set `ANTHROPIC_API_KEY` to enable Claude fallback. Without it, unresolvable tasks stay pending until a matching agent comes online.

## MCP tools

| Tool | Purpose |
|---|---|
| `get_my_tasks` | Fetch assigned tasks |
| `update_task_status` | Mark tasks in_progress, completed, blocked, etc. |
| `send_message` | Post a typed message to a thread |
| `get_unread_messages` | Check for new messages |
| `mark_thread_read` | Mark messages read |
| `list_threads` | List threads (pass `type: "plan"` for planning discussions) |
| `create_thread` | Create a thread or planning discussion |
| `list_all_tasks` | View all project tasks |
| `create_task` | Create a new task |
| `conclude_plan` | Mark a planning discussion concluded |

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://orch:orch@localhost:5433/ai_orchestrator` | |
| `API_PORT` | `3010` | |
| `API_SECRET` | — | Required; shared with all clients |
| `ANTHROPIC_API_KEY` | — | Enables Claude fallback routing |
| `ROUTING_MODEL` | `claude-haiku-4-5-20251001` | Model for routing decisions |
| `TASK_POLL_MS` | `15000` | Routing scheduler interval (ms) |
| `AGENT_ID` | — | Set after registering an agent |
| `PROJECT_ID` | — | Set after creating a project |
