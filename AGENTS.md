# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install all workspace dependencies
pnpm install

# Start Postgres (port 5433 — avoids conflict with other local DBs on 5432)
docker compose up -d

# Push Drizzle schema to the database (run once after clone, and after schema changes)
DATABASE_URL=postgresql://relai:relai@localhost:5433/relai \
  pnpm --filter @relai/db db:push

# Seed a fresh database (creates project + orchestrator agent, patches .env)
# API must be running first
API_SECRET=changeme tsx scripts/seed.ts [project-name] [agent-name] [preset]
# Add more agents to an existing project
API_SECRET=changeme tsx scripts/add-agent.ts <project-id> <agent-name> <preset>
# Presets: orchestrator, architect, writer, reviewer, tester, devops

# Start individual packages (each in its own terminal)
pnpm --filter @relai/api dev          # REST API → :3010
pnpm --filter @relai/web dev          # Web UI  → :5173
pnpm --filter @relai/mcp-server dev   # MCP stdio server (optional — for development)

# Run tests
pnpm test                             # all packages
pnpm --filter @relai/orchestrator test
pnpm --filter @relai/mcp-server test

# Typecheck all packages
pnpm typecheck

# Build all packages
pnpm build
```

drizzle-kit reads `DATABASE_URL` from the environment — there is no automatic `.env` loading for it. Pass it explicitly or `export` it first.

## Architecture

pnpm workspaces monorepo. Two shared packages feed several app packages:

```
shared/
  types/    Shared TypeScript types (MessageType, TaskStatus, RoutingMethod, …)
  db/       Drizzle ORM schema + createDb() factory; re-exports all tables

packages/
  api/            Fastify REST API — all state lives here; includes routing scheduler
  web/            React + Vite + TanStack Query dashboard
  mcp-server/     MCP server — the integration point for any MCP-compatible agent
  orchestrator/   Optional self-hosted routing daemon (alternative to built-in scheduler)
  claude-worker/  Headless Claude Code worker loop
  copilot-worker/ Copilot agent worker loop
  cli/            Commander.js CLI — orch init, register agents
```

### Data model (shared/db)

Six tables: `projects`, `agents`, `threads`, `messages`, `tasks`, `routing_log`. All IDs are prefixed strings (`proj_`, `agent_`, `thread_`, `msg_`, `task_`, `route_`). Enums are Postgres-native (`pgEnum`).

- `projects` has `routingMode` (`"automated"` | `"manual"` | null) and `anthropicApiKey` (nullable)
- `agents` has `specialization`, `workerType` (`claude` | `copilot` | `cursor` | `windsurf` | `gemini` | `gpt` | `mcp` | `human`), `repoPath`
- `threads` has `type` (null = operational, `"plan"` = collaborative planning), `status` (`"open"` | `"concluded"`), `summary`
- `tasks` has `domains`, `specialization`, `assignedTo`, `metadata` (jsonb)

### API (packages/api)

Fastify v4 with Zod validation. Every route — including `GET /health` — requires `Authorization: Bearer <API_SECRET>`. The auth plugin is registered globally via `fastify-plugin` and runs in `onRequest` before all routes.

Key routes:
- `POST /projects`, `GET /projects`, `DELETE /projects/:id`
- `POST /agents`, `PUT /agents/:id/heartbeat`, `GET /agents`, `DELETE /agents/:id`
- `POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `PUT /tasks/:id`
- `POST /threads`, `GET /threads`, `DELETE /threads/:id`, `PUT /threads/:id/conclude`
- `POST /threads/:id/messages`, `GET /threads/:id/messages`
- `GET /messages/unread?agentId=`
- `PUT /threads/:id/messages/read`
- `GET /health`

### Routing scheduler (packages/api/src/lib/router/)

Runs inside the API process — no separate daemon needed. On startup and every `TASK_POLL_MS` (default 15s), it queries for projects with `routingMode = "automated"` and for each one:

1. **Rules** (free) — domain match, specialization match, load balancing via `rules.ts`
2. **Claude fallback** — only when rules can't resolve; requires `ANTHROPIC_API_KEY`; defaults to `claude-haiku-4-5-20251001` (override with `ROUTING_MODEL`)

Also runs the blocked-task watcher: detects human replies to blocked tasks and resumes them.

The `scheduler` option on `buildServer()` is `false` in tests to avoid background polling during test runs.

### MCP server (packages/mcp-server)

Ten tools with model-agnostic descriptions (work with any MCP-compatible client):
`get_my_tasks`, `update_task_status`, `send_message`, `get_unread_messages`,
`mark_thread_read`, `list_threads`, `create_thread`, `list_all_tasks`, `create_task`, `conclude_plan`.

Supports stdio transport (default) and HTTP/SSE transport (`TRANSPORT=http`).

**MCP SDK version**: pinned to `1.6.0`. v1.29+ adds an `execution.taskSupport` field to tool definitions that Claude Code v2.x does not recognize, causing tools to be silently excluded from the deferred tool list even when the server is connected. Do not upgrade past 1.6.0 without testing.

**Tool handler return format**: all handlers must return `{ content: [{ type: "text", text: string }] }`. The SDK does not automatically wrap plain object returns — returning a plain object results in the tool appearing to succeed but delivering no content to the model.

**Zod defaults on `.shape`**: `server.tool()` receives the Zod schema's `.shape`, not the full schema object. This means `.default()` values on fields are not applied at call time. Always apply defaults manually in the handler (e.g. `const status = input.status ?? "assigned"`).

### CLI (packages/cli)

`orch init` — interactive setup wizard:
1. Prompts for API URL + secret, verifies connectivity
2. Creates a new project or accepts an existing project ID
3. Prompts for agent name and specialization (7 presets + custom)
4. Registers the agent via `POST /agents`
5. Saves config to `~/.config/orch/config.json`
6. Prints the `.mcp.json` snippet to paste into the agent's MCP config

### MCP client configuration

Add the snippet from agent registration (or `orch init`) to `.mcp.json` in the project root (project-level) or `~/.claude.json` (global). Project-level is preferred — it keeps each project's agent identity isolated.

**Tool slot limit**: Claude Code exposes a finite number of MCP tools per session. If you have many MCP servers, the relai tools may not surface. Disable unused MCP servers or move relai to `~/.claude.json` to prioritize it. The tools are working correctly if `/mcp` shows relai as connected with 10 tools.

**Repo path**: Relai stores `repoPath` on the agent record and shows it in setup instructions, but cannot enforce it for interactive sessions. Always start your agent session from the correct directory — the agent will work in whatever directory it was launched from.

## Testing

Tests use vitest. Test files live alongside source as `*.test.ts`.

Currently tested:
- `packages/orchestrator/src/router/rules.test.ts` — rules-based routing logic
- `packages/mcp-server/src/tools.test.ts` — MCP tool handlers with mocked API client

When adding new routing rules, add corresponding test cases to `rules.test.ts`. When adding or modifying MCP tools, update `tools.test.ts` — especially verify the content format and any default-value handling.

## Environment

All secrets in `.env` (see `.env.example`). Key vars:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://relai:relai@localhost:5433/relai` | |
| `API_PORT` | `3010` | |
| `API_SECRET` | — | Required; shared with all clients |
| `ANTHROPIC_API_KEY` | — | Enables Claude fallback routing; optional |
| `ROUTING_MODEL` | `claude-haiku-4-5-20251001` | Model used for routing decisions |
| `TASK_POLL_MS` | `15000` | Routing scheduler interval (ms) |
| `AGENT_ID` | — | Set after registering an agent |
| `PROJECT_ID` | — | Set after creating a project |

The `dev` scripts for `api` and `mcp-server` load `.env` automatically via `tsx watch --env-file=../../.env`. The `web` package (Vite) does not use server env vars.

## Dev setup (first time)

```bash
git clone <repo>
cd relai
cp .env.example .env
# Edit .env: set API_SECRET, optionally add ANTHROPIC_API_KEY
pnpm install
docker compose up -d
DATABASE_URL=postgresql://relai:relai@localhost:5433/relai \
  pnpm --filter @relai/db db:push
pnpm --filter @relai/api dev        # terminal 1
API_SECRET=<your-secret> tsx scripts/seed.ts my-project my-agent orchestrator
pnpm --filter @relai/web dev        # terminal 2
```

Then open http://localhost:5173, enter the API URL and secret.

## Critical rules

- **All routes require auth** — there is no public endpoint. Even `GET /health` requires a valid bearer token.
- **Port 5433 for Postgres** — docker-compose maps `5433:5432` to avoid conflicting with other local databases.
- **Port 3010 for API** — avoids common dev server port conflicts.
- **drizzle-kit does not auto-load `.env`** — always pass `DATABASE_URL` explicitly.
- **`tsx watch --env-file` flag order** — `tsx watch --env-file=../../.env src/index.ts` (watch before flag). Reversing causes tsx to treat `watch` as the script path.
- **Routing is sequential, not parallel** — tasks are routed one at a time to avoid racing on agent availability.
- **MCP tool handlers must return MCP content format** — see MCP server section above.
- **MCP SDK pinned at 1.6.0** — do not upgrade without testing tool visibility in Claude Code.
- **Scheduler disabled in tests** — `buildServer({ scheduler: false })` in test files to prevent background polling.
