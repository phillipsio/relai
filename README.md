# Relai

A coordination layer for multi-agent AI development teams. Any MCP-compatible agent — Claude Code, Copilot, Cursor, Windsurf, Gemini, or anything else that speaks MCP — connects to a shared task queue, message bus, and planning workspace managed through a web dashboard.

## Direction

Relai is mid-redesign. The current code (described below) still works, but the system is moving toward a different shape:

- **CLI-first, not dashboard-first.** Agents and humans use the same `relai` commands; the web becomes a read-only window into the same state. New capabilities ship as commands, not forms.
- **Per-agent tokens, not a shared secret.** Each agent has its own credential, scoped to a project. The shared `API_SECRET` is now a deprecated fallback. *(Done — issued at registration and via `relai token rotate`.)*
- **Agents as peers, not workers in a queue.** Any agent can create tasks, delegate to peers, spawn sub-agents, and open threads with other agents directly. Routing is per-task opt-in: `assignedTo: "@auto"` tells the scheduler to pick. Projects can set `defaultAssignee` (an agent ID, `"@auto"`, or null) as the fallback when no assignee is given. The old `automated`/`manual` mode is gone. *(Done.)*
- **Humans optional, not central.** A human is an agent with `workerType: human` who *subscribes* to threads/tasks they care about. The SSE event stream (`GET /events`) and `subscriptions` table are in; webhook/email notification channels are still ahead. *(Subscriptions + SSE done; channels next.)*
- **Internet-native.** Project invites (`relai project invite` → `relai login --invite`) and per-agent local clones (`git`/`gh` shelled out by the worker) make multi-machine coordination the default rather than a special case. *(Invites done.)*

Project remains the trust and repo boundary: joining a project grants visibility to all of its tasks, threads, and messages. There are no per-thread ACLs.

The full design is tracked in `~/.claude/projects/-Users-jim-PhpstormProjects-relai/memory/project_cli_design.md`. If you make a change that contradicts the bullets above, that's drift — flag it before it lands.

## What it does

- **Agent-agnostic** — any MCP client can register as a worker. Agents identify themselves but Relai doesn't care what model or IDE is on the other end
- **Task routing** — create tasks with an explicit assignee, or use `@auto` (per-task or as a project default) to let the built-in scheduler route via rules with Claude as a fallback
- **Threads** — typed message passing between agents and humans (`handoff`, `finding`, `decision`, `question`, `escalation`, `reply`)
- **Plans** — collaborative planning discussions where any agent or human can contribute before work begins
- **Project invites** — host runs `relai project invite`, coworker runs `relai login --invite <code>`; per-agent tokens are issued automatically
- **Event stream** — `GET /events` is an SSE stream filtered to each agent's subscriptions (auto-subscribed on message/task creation)
- **Web dashboard** — read-only-ish view of projects, agents, tasks, threads, and plans

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

The routing scheduler runs inside the API process — no separate daemon needed. It scans for `pending` tasks flagged for auto-routing (per task or via the project's `defaultAssignee`) and assigns them. Workers connect via MCP and use tools to pick up tasks, send messages, and contribute to plans.

## Packages

| Package                  | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `packages/api`           | Fastify REST API — all state lives here, includes routing scheduler  |
| `packages/web`           | React dashboard — projects, tasks, agents, threads, plans            |
| `packages/mcp-server`    | MCP server — what AI agents connect to                               |
| `packages/orchestrator`  | Optional self-hosted routing daemon                                  |
| `packages/claude-worker` | Headless Claude Code worker loop                                     |
| `packages/copilot-worker`| Copilot agent worker loop                                            |
| `packages/cli`           | `relai` CLI — register agents, init config                            |
| `shared/db`              | Drizzle ORM schema + Postgres client                                 |
| `shared/types`           | Shared TypeScript types                                              |

## Getting started

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker (for Postgres) or a Postgres 16+ instance

### 1. Clone and install

```bash
git clone <repo-url>
cd relai
pnpm install
```

### 2. Start Postgres

```bash
docker compose up -d
```

### 3. Configure environment

```bash
cp .env.example .env
# Set API_SECRET to something strong (used by seed scripts and the deprecated
# shared-secret auth fallback; per-agent tokens replace it for runtime clients)
# Add ANTHROPIC_API_KEY if you want Claude fallback routing
```

### 4. Push the database schema

```bash
DATABASE_URL=postgresql://relai:relai@localhost:5433/relai \
  pnpm --filter @getrelai/db db:push
```

### 5. Seed a project

```bash
pnpm --filter @getrelai/api dev   # start the API first (terminal 1)

# In another terminal:
API_SECRET=changeme pnpm exec tsx scripts/seed.ts my-project my-agent claude
```

### 6. Start the web dashboard

```bash
pnpm --filter @getrelai/web dev   # http://localhost:5173 (terminal 2)
```

Open the dashboard, enter your API URL (`http://localhost:3010`) and secret. The routing scheduler starts automatically with the API.

### 7. Register additional agents

The seed in step 5 already created your first agent. To add more, you have three paths:

**`relai login --invite <code>`** (preferred for coworkers / extra identities)

```bash
# On the host:
relai project invite                                 # prints an `relai login` snippet

# On the new machine (no clone required — relai is on npm):
npm install -g @getrelai/cli
relai login --invite <code> --api <PUBLIC_API_URL>   # exchanges code for a per-agent token
```

This is the only path that issues a per-agent token without exposing the admin secret. The printed snippet uses `npx @getrelai/mcp-server` so the MCP server also installs on demand — no clone for coworkers.

**Dashboard → Agents → Add agent** — registers an agent and prints the `.mcp.json` snippet. Useful when you have admin-secret access and want a click-through flow.

**`pnpm start-worker`** — autonomous Claude worker loop:

```bash
API_SECRET=changeme PROJECT_ID=proj_xxx \
  pnpm start-worker claude --repo /path/to/your/repo
```

Registers the agent (or reuses an existing one with the same name) and starts a headless Claude Code loop that polls for tasks. Run multiple instances with different `--name` and `--repo` flags for parallel workers.

For an interactive session, drop the `.mcp.json` snippet into your project root and start Claude Code normally. The agent connects on startup and appears online in the dashboard.

### 8. Create tasks

Tasks default to `pending` with no assignee. Three ways to get them moving:

- **Explicit assignee** — `relai task create --to <agent-name>` or set `assignedTo` in `POST /tasks`. The task goes to `assigned` immediately.
- **Per-task auto-routing** — `relai task create --to @auto` (or `assignedTo: "@auto"`). The scheduler picks an agent on the next tick.
- **Project default** — set `defaultAssignee` (an agent ID, `"@auto"`, or null) when creating the project. Tasks created without an explicit assignee inherit it.

### Behavior-grounded completion

Add `--verify <cmd>` (and optionally `--verify-cwd <path>`) to gate the `completed` transition on a shell predicate. When set:

- An agent calling `update_task_status` with `completed` (or `relai task done <id>`) sees the status rewritten to `pending_verification`.
- The scheduler runs the predicate on the next tick (60s timeout, 8KB stdout/stderr cap; full transcript stored in `verification_log`).
- Exit `0` promotes to `completed` and emits `task.verified`. Anything else returns the task to `assigned` with `metadata.lastVerification` populated and emits `task.verification_failed`, so the agent retries.
- Stuck claims older than 5 min are reaped as crashed runs.

Example: `relai task create -t "fix tests" -d "..." --verify "pnpm --filter @getrelai/api test"` — the task can't be self-marked done unless the test command exits 0.

## Routing

The scheduler runs every 15 seconds. It picks up `pending` tasks flagged for auto-assignment (`autoAssign = true`) — set either by `assignedTo: "@auto"` on the task or by inheriting a project's `defaultAssignee = "@auto"` — and routes each:

1. **Rules** (free) — domain match, specialization match, load balancing
2. **Claude fallback** — only when rules can't resolve; uses `claude-haiku-4-5-20251001` by default

Set `ANTHROPIC_API_KEY` to enable Claude fallback. Without it, unresolvable tasks stay pending until a matching agent comes online. Tasks with an explicit human-chosen assignee never go through the scheduler.

## MCP tools

| Tool                  | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `get_my_tasks`        | Fetch assigned tasks                                        |
| `update_task_status`  | Mark tasks in_progress, completed, blocked, etc.            |
| `send_message`        | Post a typed message to a thread                            |
| `get_unread_messages` | Check for new messages                                      |
| `mark_thread_read`    | Mark messages read                                          |
| `list_threads`        | List threads (pass `type: "plan"` for planning discussions) |
| `create_thread`       | Create a thread or planning discussion                      |
| `list_all_tasks`      | View all project tasks                                      |
| `conclude_plan`       | Mark a planning discussion concluded                        |

## Environment variables

| Variable            | Default                                         | Notes                                                                                                                                                       |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | `postgresql://relai:relai@localhost:5433/relai` |                                                                                                                                                             |
| `API_PORT`          | `3010`                                          |                                                                                                                                                             |
| `API_SECRET`        | —                                               | Deprecated shared fallback. Used by seed scripts and pre-token clients; new work should use per-agent tokens issued at registration or via `relai token rotate`. |
| `ANTHROPIC_API_KEY` | —                                               | Enables Claude fallback routing                                                                                                                             |
| `ROUTING_MODEL`     | `claude-haiku-4-5-20251001`                     | Model for routing decisions                                                                                                                                 |
| `TASK_POLL_MS`      | `15000`                                         | Routing scheduler interval (ms)                                                                                                                             |
| `AGENT_ID`          | —                                               | Set after registering an agent                                                                                                                              |
| `PROJECT_ID`        | —                                               | Set after creating a project                                                                                                                                |
| `RELAI_CONFIG_DIR`   | `~/.config/relai`                                | Override CLI config location (multi-identity testing)                                                                                                       |
