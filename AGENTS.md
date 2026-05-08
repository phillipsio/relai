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
  pnpm --filter @getrelai/db db:push

# Seed a fresh database (creates project + orchestrator agent, patches .env)
# API must be running first
API_SECRET=changeme tsx scripts/seed.ts [project-name] [agent-name] [preset]
# Add more agents to an existing project
API_SECRET=changeme tsx scripts/add-agent.ts <project-id> <agent-name> <preset>
# Presets: claude, copilot, architect, writer, reviewer, tester, devops

# Start individual packages (each in its own terminal)
pnpm --filter @getrelai/api dev          # REST API → :3010
pnpm --filter @getrelai/web dev          # Web UI  → :5173
pnpm --filter @getrelai/mcp-server dev   # MCP stdio server (optional — for development)

# Run tests
pnpm test                             # all packages
pnpm --filter @getrelai/api test
pnpm --filter @getrelai/orchestrator test
pnpm --filter @getrelai/mcp-server test

# Typecheck all packages
pnpm typecheck

# Build all packages
pnpm build
```

drizzle-kit reads `DATABASE_URL` from the environment — there is no automatic `.env` loading for it. Pass it explicitly or `export` it first.

**Schema renames bypass `db:push`.** drizzle-kit's `push` is interactive and prompts on column renames (e.g. `routing_mode → default_assignee`), which makes it unscriptable. For a rename, run the `ALTER TABLE … RENAME COLUMN …` directly via `docker exec relai-postgres-1 psql -U relai -d relai -c "..."` and let `db:push` reconcile the rest on the next run.

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
  cli/            Commander.js CLI — the `relai` binary
```

### Data model (shared/db)

Twelve tables: `projects`, `agents`, `tokens`, `invites`, `threads`, `messages`, `tasks`, `subscriptions`, `notification_channels`, `verification_log`, `events`, `routing_log`. All IDs are prefixed strings (`proj_`, `agent_`, `thread_`, `msg_`, `task_`, `route_`, `tok_`, `inv_`, `sub_`, `evt_`, `verif_`). Enums are Postgres-native (`pgEnum`).

- `projects` has `defaultAssignee` (agent ID, the literal `"@auto"`, or null) — applied when a task is created without an explicit assignee
- `agents` has `specialization`, `workerType` (`claude` | `copilot` | `cursor` | `windsurf` | `gemini` | `gpt` | `mcp` | `human`), `repoPath`
- `tokens` is the per-agent bearer-credential store: hashed token, `lastUsedAt`, `revokedAt`. Issued at agent registration and via `POST /agents/:id/tokens`
- `invites` is the project-join channel: hashed code, `expiresAt`, `acceptedAt`, optional suggested name/specialization
- `threads` has `type` (null = operational, `"plan"` = collaborative planning), `status` (`"open"` | `"concluded"`), `summary`
- `tasks` has `domains`, `specialization`, `assignedTo`, `autoAssign` (true when the effective assignee is `"@auto"`), `metadata` (jsonb), and an optional `verifyCommand` / `verifyCwd` predicate plus optional `verifyTimeoutMs` (per-task override, bounded `[1_000, 600_000]`; default 60s). When `verifyCommand` is set, `PUT /tasks/:id { status: "completed" }` rewrites the transition to `pending_verification`; the API scheduler runs the shell predicate (8KB stdout/stderr cap, written to `verification_log`). Exit `0` promotes to `completed` and emits `task.verified`; anything else returns the task to `assigned` with `metadata.lastVerification` populated and emits `task.verification_failed`. Stuck claims older than 5 min are reaped as crashed runs.
- `subscriptions` records which agents want event notifications for a given thread/task/agent target
- `events` is the persisted mirror of the in-process bus; written on every `publish()` so `/session/start` can show what an agent missed. SSE stays live; this table is history.

### Auth (packages/api/src/plugins/auth.ts)

Per-agent bearer tokens. Every route — including `GET /health` — runs through the auth plugin in `onRequest` before the handler. The plugin:

1. Hashes the incoming `Authorization: Bearer <token>`, looks it up in `tokens`, and on hit attaches the resolved agent to `request.agent`. Fire-and-forget bumps both `tokens.lastUsedAt` and `agents.lastSeenAt` — the latter is what the routing scheduler's "online" filter (10-min window) reads, so any authenticated request keeps the agent visible to the router, not just explicit `/heartbeat` calls.
2. Falls back to comparing against `API_SECRET` if no token matches. This path is **deprecated** — kept so the seed scripts and any pre-token clients keep working — and logs a one-time warning. Do not introduce new code that depends on the shared secret.
3. Whitelists `POST /auth/accept-invite` (no token required; the invite code is the credential).

`request.agent` is the canonical caller identity — prefer it over re-deriving from request bodies.

### Key routes (packages/api)

Fastify v4 with Zod validation throughout.

**Projects**
- `POST /projects`, `GET /projects`, `GET /projects/:id`, `PUT /projects/:id`, `DELETE /projects/:id`

**Agents & tokens**
- `POST /agents` — registers an agent and returns a one-time plaintext token alongside the record
- `POST /agents/:id/tokens` — rotate; returns a new plaintext token
- `DELETE /tokens/:id` — revoke
- `PUT /agents/:id/heartbeat`, `GET /agents`, `GET /agents/:id`, `DELETE /agents/:id`

**Invites**
- `POST /projects/:id/invites` — create one-time join code
- `GET /projects/:id/invites`, `DELETE /invites/:id`
- `POST /auth/accept-invite` — public route; redeems a code, registers a fresh agent + token

**Tasks**
- `POST /tasks`, `GET /tasks?projectId=&status=&assignedTo=`, `GET /tasks/:id`, `PUT /tasks/:id`

**Threads & messages**
- `POST /threads`, `GET /threads?projectId=&type=`, `DELETE /threads/:id`, `PUT /threads/:id/conclude`
- `POST /threads/:id/messages`, `GET /threads/:id/messages`, `PUT /threads/:id/messages/read`
- `GET /messages/unread?agentId=&projectId=` — both params required

**Subscriptions & events**
- `POST /subscriptions`, `GET /subscriptions?agentId=`, `DELETE /subscriptions/:id`
- `GET /events` — Server-Sent Events stream filtered to the caller's subscriptions; auto-subscribes the caller on message/task creation

Every published event is also persisted to the `events` table on write, so `/session/start` can return what an agent missed since their last read. SSE remains the live channel; the table is history.

**Session**
- `GET /session/start?projectId=` — bundled snapshot for a fresh agent: agent + project + my open tasks + unread messages + open subscribed threads + `recentEvents` (last 50 the agent is subscribed to or directly notified about, newest first). Requires a per-agent token; the deprecated `API_SECRET` fallback is rejected.

**Other**
- `POST /routing-log`, `GET /routing-log?taskId=&assignedTo=` (audit)
- `GET /health`

### Routing scheduler (packages/api/src/lib/router/)

Runs inside the API process — no separate daemon needed. On startup and every `TASK_POLL_MS` (default 15s), the scheduler:

1. Scans for `pending` tasks with `autoAssign = true` (and any project with blocked tasks for the resume-watcher), groups by project, and runs one cycle per affected project.
2. Per task: tries **Rules** routing (`rules.ts`) — domain match, specialization match, load balancing. Candidates are pre-filtered to "online" agents (`lastSeenAt` within 10 min); see the auth section for what bumps that field.
3. Falls back to **Claude routing** only when rules can't resolve. Requires `ANTHROPIC_API_KEY`; defaults to `claude-haiku-4-5-20251001` (override via `ROUTING_MODEL`).

The blocked-task watcher detects human replies on threads referenced by `task.metadata.blockedThreadId` and resumes those tasks back to `assigned`.

The `scheduler` option on `buildServer()` is `false` in tests to avoid background polling during test runs.

### MCP server (packages/mcp-server)

Ten tools with model-agnostic descriptions (work with any MCP-compatible client):
`get_my_tasks`, `update_task_status`, `send_message`, `get_unread_messages`, `mark_thread_read`, `list_threads`, `create_thread`, `conclude_plan`, `list_all_tasks`, `session_start`.

Supports stdio transport (default) and HTTP/SSE transport (`TRANSPORT=http`).

**MCP SDK version**: pinned to `1.6.0`. v1.29+ adds an `execution.taskSupport` field to tool definitions that Claude Code v2.x does not recognize, causing tools to be silently excluded from the deferred tool list even when the server is connected. Do not upgrade past 1.6.0 without testing.

**Tool handler return format**: all handlers must return `{ content: [{ type: "text", text: string }] }`. The SDK does not automatically wrap plain object returns — returning a plain object results in the tool appearing to succeed but delivering no content to the model.

**Zod defaults on `.shape`**: `server.tool()` receives the Zod schema's `.shape`, not the full schema object. This means `.default()` values on fields are not applied at call time. Always apply defaults manually in the handler (e.g. `const status = input.status ?? "assigned"`).

### CLI (packages/cli)

The `relai` binary is the operator surface. It reads its config from `~/.config/relai/config.json` (override the dir with `RELAI_CONFIG_DIR` for solo multi-identity testing).

**Setup**
- `relai init` — interactive first-time setup: prompts for API URL + admin secret, creates a project (or accepts an existing project ID), registers an agent, saves the per-agent token, prints the `.mcp.json` snippet
- `relai login --invite <code> [--api <url>]` — accept a project invite as a new agent (defaults `workerType: "human"`); refuses to clobber an existing config
- `relai token rotate` / `relai token revoke <tokenId>`

**Discovery**
- `relai projects` — list projects on the server
- `relai project show [id]` — show the current (or specified) project's details
- `relai agents` — list agents in the current project (online indicator + you marker)
- `relai status` — agent identity, online agents, task summary, unread count

**Tasks**
- `relai tasks [--all] [--status ...]` — list (default: your assigned + in_progress)
- `relai task create [-t -d -p --to <agent|@auto> --domains --specialization]`
- `relai task start|done|block|cancel <id> [--note ...]`

**Threads & messages**
- `relai threads`, `relai thread new <title>`
- `relai send <threadId> [-m -t --to <agent|@auto>]` — `--to` accepts agent name or ID
- `relai inbox [-r]` — unread messages

**Project ops**
- `relai project invite [-n -s --ttl ...]` — issue a one-time invite code for `relai login`

The `--to <name>` flag in both `task create` and `send` resolves through `packages/cli/src/lib/resolve.ts` (case-insensitive name match; passes through `agent_*` IDs and the literal `@auto`).

### MCP client configuration

Add the snippet from `relai init` (or `relai login`) to `.mcp.json` in the project root (project-level) or `~/.claude.json` (global). Project-level is preferred — it keeps each project's agent identity isolated. The snippet wires the per-agent token into `API_SECRET` for the MCP server, which sends it as the bearer credential.

**Tool slot limit**: Claude Code exposes a finite number of MCP tools per session. If you have many MCP servers, the relai tools may not surface. Disable unused MCP servers or move relai to `~/.claude.json` to prioritize it. The tools are working correctly if `/mcp` shows relai as connected with ten tools.

**Repo path**: Relai stores `repoPath` on the agent record and shows it in setup instructions, but cannot enforce it for interactive sessions. Always start your agent session from the correct directory — the agent will work in whatever directory it was launched from.

## Testing

Tests use vitest. Test files live alongside source as `*.test.ts`.

Currently tested:
- `packages/api/src/routes/api.test.ts` — full route coverage with `app.inject()` against a real Postgres
- `packages/api/src/routes/auth.test.ts` — token resolution, deprecated-secret fallback, whitelist
- `packages/api/src/routes/invites.test.ts` — invite create + accept + expiry
- `packages/api/src/routes/events.test.ts` — SSE subscription fan-out + persisted-event side effects
- `packages/api/src/routes/session.test.ts` — `/session/start` bundle (tasks, unread, threads, recentEvents)
- `packages/api/src/routes/notification-channels.test.ts` — webhook fan-out, HMAC signing, retry/backoff, circuit breaker
- `packages/api/src/lib/router/scheduler.test.ts` — stall detection
- `packages/api/src/lib/router/verify-scheduler.test.ts` — verification predicate execution and stuck-claim recovery
- `packages/api/src/lib/verify.test.ts` — predicate executor (timeout, stdout/stderr cap)
- `packages/orchestrator/src/router/rules.test.ts` — rules-based routing logic
- `packages/orchestrator/src/message-loop.test.ts` — handoff/finding/decision/question/escalation handling
- `packages/mcp-server/src/tools.test.ts` — MCP tool handlers with mocked API client

Total ~209 tests across the workspace (api alone: 113). When adding routes, update `api.test.ts`. When adding routing rules, update `rules.test.ts`. When adding or modifying MCP tools, update `tools.test.ts` — especially verify the content format and any default-value handling.

## Environment

All secrets in `.env` (see `.env.example`). Key vars:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://relai:relai@localhost:5433/relai` | |
| `API_PORT` | `3010` | |
| `API_SECRET` | — | Deprecated shared fallback; still used by seed scripts and pre-token clients. New work should use per-agent tokens issued by `POST /agents` / `POST /agents/:id/tokens`. |
| `ANTHROPIC_API_KEY` | — | Enables Claude fallback routing; optional |
| `ROUTING_MODEL` | `claude-haiku-4-5-20251001` | Model used for routing decisions |
| `TASK_POLL_MS` | `15000` | Routing scheduler interval (ms) |
| `AGENT_ID` | — | Set after registering an agent |
| `PROJECT_ID` | — | Set after creating a project |
| `RELAI_CONFIG_DIR` | `~/.config/relai` | Override CLI config location (multi-identity testing) |

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
  pnpm --filter @getrelai/db db:push
pnpm --filter @getrelai/api dev        # terminal 1 — must be running before seed
# In a second terminal:
API_SECRET=<your-secret> tsx scripts/seed.ts my-project my-agent orchestrator
pnpm --filter @getrelai/web dev        # terminal 3
```

Then open http://localhost:5173, enter the API URL and secret.

For a coworker joining an existing project, see `docs/two-person-test.md`: the host runs `relai project invite`, the coworker runs `relai login --invite <code>`.

## Deploy

The repo ships a production `Dockerfile` + `fly.toml` targeting Fly.io. The image runs the API from TypeScript source under `tsx` (the shared `db` and `types` packages export `src/` directly, so there's no monorepo build step). Schema migrations run automatically via the `[deploy] release_command` in `fly.toml` (`pnpm --filter @getrelai/db db:push`); column renames must still be applied manually via raw SQL first. See `docs/deploy-fly.md` for the full walkthrough.

`/health` is auth-gated, so the Fly health probe is a TCP check today. The web dashboard isn't deployed by this config — host it separately or skip for CLI/MCP-only setups.

## Critical rules

- **All routes require auth** — there is no public endpoint except `POST /auth/accept-invite` (whitelisted). Even `GET /health` requires a valid bearer token (per-agent token or the deprecated `API_SECRET` fallback).
- **Port 5433 for Postgres** — docker-compose maps `5433:5432` to avoid conflicting with other local databases.
- **Port 3010 for API** — avoids common dev server port conflicts.
- **drizzle-kit does not auto-load `.env`** — always pass `DATABASE_URL` explicitly.
- **drizzle-kit `push` prompts on renames** — apply `ALTER TABLE … RENAME COLUMN` directly via `docker exec` instead.
- **`tsx watch --env-file` flag order** — `tsx watch --env-file=../../.env src/index.ts` (watch before flag). Reversing causes tsx to treat `watch` as the script path.
- **Routing is sequential, not parallel** — tasks are routed one at a time within a cycle to avoid racing on agent availability.
- **MCP tool handlers must return MCP content format** — see MCP server section above.
- **MCP SDK pinned at 1.6.0** — do not upgrade without testing tool visibility in Claude Code.
- **Scheduler disabled in tests** — `buildServer({ scheduler: false })` in test files to prevent background polling.
