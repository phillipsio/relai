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

# Seed a fresh database (creates repo + orchestrator agent, patches .env)
# API must be running first
API_SECRET=changeme tsx scripts/seed.ts [repo-name] [agent-name] [preset]
# Add more agents to an existing repo
API_SECRET=changeme tsx scripts/add-agent.ts <repo-id> <agent-name> <preset>
# Presets: architect, writer, reviewer, tester, devops (role-based, model-agnostic)

# Start individual packages (each in its own terminal)
pnpm --filter @getrelai/api dev          # REST API → :3010
pnpm --filter @getrelai/web dev          # Web UI  → :5173
pnpm --filter @getrelai/mcp-server dev   # MCP stdio server (optional — for development)

# Run tests
pnpm test                             # all packages
pnpm --filter @getrelai/api test
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
  api/            Fastify REST API — all state lives here; includes routing scheduler and (opt-in) message loop
  web/            React + Vite + TanStack Query dashboard (Issues + Epics surface)
  mcp-server/     MCP server — the integration point for any MCP-compatible agent
  claude-worker/  Headless Claude Code worker loop
  copilot-worker/ Copilot agent worker loop
  cli/            Commander.js CLI — the `relai` binary
```

### Data model (shared/db)

Twelve tables: `repos`, `agents`, `tokens`, `invites`, `threads`, `messages`, `tasks`, `subscriptions`, `notification_channels`, `verification_log`, `events`, `routing_log`. All IDs are prefixed strings (`repo_`, `agent_`, `thread_`, `msg_`, `task_`, `route_`, `tok_`, `inv_`, `sub_`, `evt_`, `verif_`). Enums are Postgres-native (`pgEnum`).

- `repos` has `defaultAssignee` (agent ID, the literal `"@auto"`, or null) — applied when a task is created without an explicit assignee
- `agents` has `specialization`, `tier` (operator-defined seniority for escalation routing — 1=clear-brief, 2=takes-escalations, null=untiered; orthogonal to model), `workerType` (`claude` | `copilot` | `cursor` | `windsurf` | `gemini` | `gpt` | `mcp` | `human`), `repoPath`
- `tokens` is the per-agent bearer-credential store: hashed token, `lastUsedAt`, `revokedAt`. Issued at agent registration and via `POST /agents/:id/tokens`
- `invites` is the repo-join channel: hashed code, `expiresAt`, `acceptedAt`, optional suggested name/specialization
- `threads` has `type` (null = operational, `"plan"` = collaborative planning, surfaced as an **Epic** in the UI), `status` (`"open"` | `"concluded"`), `summary`, and `taskId` (back-link when the thread is an Issue's comment surface; null for Epics/standalone). The unified Epic → Issue UI presents `tasks` as Issues and `type="plan"` threads as Epics (see `docs/threading-model.md`); a task's discussion lives on its linked thread, exposed via `/tasks/:id/comments`. `archivedAt` (nullable) hides a concluded thread from default views without deleting it (see `PUT /threads/:id/archive`).
- `tasks` has `domains`, `specialization`, `assignedTo`, `autoAssign` (true when the effective assignee is `"@auto"`), `metadata` (jsonb), and an optional verification predicate. **Propose-vs-commit:** committing work (giving it an owner + entering the lifecycle) is an orchestrator act. When a non-orchestrator agent calls `POST /tasks`, the task lands in status `"proposed"` (inert — the routing and verify schedulers skip it), with any requested assignee stashed as a non-binding hint in `metadata.proposal.suggestedAssignee` and the repo's orchestrators auto-subscribed + notified via `task.proposed`. An orchestrator (or the deprecated admin-secret path) commits it via `POST /tasks/:id/commit` (assign + optional ratified edits → `assigned`/`pending`, emits `task.committed`) or rejects it (→ `cancelled`, emits `task.proposal_rejected`). Orchestrator/admin creates are committed immediately, preserving prior behavior. Four verify kinds: `verifyKind = "shell"` (uses `verifyCommand` + optional `verifyCwd` + optional `verifyTimeoutMs` bounded `[1_000, 600_000]`, default 60s — legacy rows with null `verifyKind` and `verifyCommand` set are treated as shell), `verifyKind = "file_exists"` (uses `verifyPath` resolved against `verifyCwd`; no shell exec), `verifyKind = "thread_concluded"` (uses `verifyThreadId`; passes when the referenced thread's status is `"concluded"`; no shell exec), and `verifyKind = "reviewer_agent"` (uses `verifyReviewerId`; passes when the named agent posts an approve decision via `POST /tasks/:id/review`, fails on reject; the scheduler skips the row until a decision lands). **Authoring a shell predicate requires `request.agent.role === "orchestrator"` or the deprecated admin-secret path** — workers and other roles get 403. The structured kinds are unrestricted. When any predicate is set, `PUT /tasks/:id { status: "completed" }` rewrites the transition to `pending_verification`; the API scheduler runs the predicate (shell kind: 8KB stdout/stderr cap; written to `verification_log` for all kinds). Exit `0` promotes to `completed` and emits `task.verified`; anything else returns the task to `assigned` with `metadata.lastVerification` populated and emits `task.verification_failed`. For `reviewer_agent`, entering `pending_verification` also emits `task.review_requested` (notifying the reviewer + auto-subscribing them); the review endpoint emits `task.review_submitted` when the reviewer decides. Stuck claims older than 5 min are reaped as crashed runs. The predicate is **editable post-creation via `PUT /tasks/:id`** (e.g. re-point `verifyReviewerId`, swap kind): the update validates the merged (existing+patch) config and re-applies the shell-author gate + reviewer-existence check. Tasks also carry `epicId` (parent Epic — a `"plan"` thread; formalizes the old informal `metadata.planThreadId`) and `threadId` (the Issue's comment thread, created lazily on first `/tasks/:id/comments` access). `archivedAt` (nullable) hides a terminal task from default views without deleting it (see `PUT /tasks/:id/archive`).
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

**Repos**
- `POST /repos`, `GET /repos`, `GET /repos/:id`, `PUT /repos/:id`, `DELETE /repos/:id`

**Agents & tokens**
- `POST /agents` — registers an agent and returns a one-time plaintext token alongside the record
- `POST /agents/:id/tokens` — rotate; returns a new plaintext token
- `DELETE /tokens/:id` — revoke
- `PUT /agents/:id/heartbeat`, `GET /agents`, `GET /agents/:id`, `DELETE /agents/:id`

**Invites**
- `POST /repos/:id/invites` — create one-time join code
- `GET /repos/:id/invites`, `DELETE /invites/:id`
- `POST /auth/accept-invite` — public route; redeems a code, registers a fresh agent + token

**Tasks**
- `POST /tasks`, `GET /tasks?repoId=&status=&assignedTo=&epicId=&archived=`, `GET /tasks/:id`, `PUT /tasks/:id` (`epicId=` filters an Epic's child Issues; archived tasks are excluded unless `archived=true`)
- `PUT /tasks/:id/archive` — archive a `completed`/`cancelled` task out of the default lists + `session_start` (sets `archivedAt`; 409 if non-terminal; idempotent). History stays queryable via `archived=true`. Orthogonal to status — archiving is not deletion.
- `GET /tasks/:id/comments` — returns `{ threadId, comments }` for the Issue's comment thread, creating + linking it lazily on first access. `POST /tasks/:id/comments { body, type? }` posts a comment (caller identity, or `"human"` on the admin path). This is the unified-UI view of a task's linked thread; messages still flow through the `threads`/`messages` tables underneath.
- `POST /tasks/:id/commit` — orchestrator commits (or rejects) a `"proposed"` task. Body `{ decision: "commit"|"reject" (default "commit"), assignedTo? (agent id | "@auto" | omit→repo default), note?, + optional ratified edits: title/description/priority/domains/specialization/verify* }`. Caller must be an orchestrator agent **or** the deprecated admin-secret path; others get 403. Only a `"proposed"` task is committable (others → 409). On commit it resolves the effective assignee exactly like create, applies edits (re-validating any verify changes via the shared consistency + reviewer-existence checks), writes `metadata.commit = { committedBy, committedAt }`, transitions to `assigned`/`pending`, and emits `task.committed`. On reject it sets `cancelled`, records `metadata.proposal.rejectedBy/rejectedAt/note`, and emits `task.proposal_rejected` (notifying the proposer).
- `POST /tasks/:id/review` — reviewer-agent decision endpoint. Body `{ decision: "approve"|"reject", note? }`. Caller must equal `tasks.verifyReviewerId`, **or** authenticate via the deprecated admin-secret path (in which case the decision is recorded as belonging to the named reviewer with `metadata.review.submittedBy = "admin"`, so the self-hosted dashboard can stand in as a human reviewer). Accepted from any active state (`assigned`/`in_progress`/`pending_verification`); if the task isn't already `pending_verification` the endpoint moves it there as it records the decision (so a reviewer can sign off without the worker first transitioning it). Terminal states (`completed`/`cancelled`) are rejected. Writes the decision into `metadata.review` and resolves it synchronously (runs the verification inline via the scheduler's `verifyTask`), so the response already reflects the final state — `completed` on approve, `assigned` on reject. The verify scheduler remains a fallback if the row can't be claimed inline.

**Threads & messages**
- `POST /threads`, `GET /threads?repoId=&type=&archived=`, `DELETE /threads/:id`, `PUT /threads/:id/conclude`, `PUT /threads/:id/archive` (archive a `concluded` thread — plan OR operational — out of default lists + `session_start`; 409 if not concluded; idempotent; `archived=true` to include)
- `POST /threads/:id/messages`, `GET /threads/:id/messages`, `PUT /threads/:id/messages/read`
- `GET /messages/unread?agentId=&repoId=` — both params required

**Subscriptions & events**
- `POST /subscriptions`, `GET /subscriptions?agentId=`, `DELETE /subscriptions/:id`
- `GET /events` — Server-Sent Events stream filtered to the caller's subscriptions; auto-subscribes the caller on message/task creation

Every published event is also persisted to the `events` table on write, so `/session/start` can return what an agent missed since their last read. SSE remains the live channel; the table is history.

**Session**
- `GET /session/start?repoId=` — bundled snapshot for a fresh agent: agent + repo + my open tasks + unread messages + open subscribed threads + `recentEvents` (last 50 the agent is subscribed to or directly notified about, newest first). Requires a per-agent token; the deprecated `API_SECRET` fallback is rejected.

**Other**
- `POST /routing-log`, `GET /routing-log?taskId=&assignedTo=` (audit)
- `GET /health`

### Routing scheduler (packages/api/src/lib/router/)

Runs inside the API process — no separate daemon needed. On startup and every `TASK_POLL_MS` (default 15s), the scheduler:

1. Scans for `pending` tasks with `autoAssign = true` (and any repo with blocked tasks for the resume-watcher), groups by repo, and runs one cycle per affected repo.
2. Per task: tries **Rules** routing (`rules.ts`) — domain match, specialization match, load balancing. Candidates are pre-filtered to "online" agents (`lastSeenAt` within 10 min); see the auth section for what bumps that field.
3. Falls back to **Claude routing** only when rules can't resolve. Requires `ANTHROPIC_API_KEY`; defaults to `claude-haiku-4-5-20251001` (override via `ROUTING_MODEL`).

The blocked-task watcher detects human replies on threads referenced by `task.metadata.blockedThreadId` and resumes those tasks back to `assigned`. The proposed-task watcher emits a one-time `task.proposed_overdue` (notifying the repo's orchestrators) when a worker's `proposed` task waits past `PROPOSED_OVERDUE_MS` without being committed, so proposals don't stall silently when no orchestrator is acting.

**Message loop (opt-in):** when `ENABLE_MESSAGE_ROUTING=true`, the same scheduler runs `message-loop.ts` per repo per tick. For each repo's `role="orchestrator"` agent, it processes the agent's repo-wide unread feed:
- `status`/`reply` — mark read, no other action
- `escalation` — find an online tier-2 senior (or `architect` specialization fallback), create a `high`-priority task assigned directly to them, post a reply on the originating thread
- `decision` — broadcast to every online worker on the same thread
- `handoff`/`question`/`finding` — call Claude with the `route_message` tool to choose between `create_task` / `forward` / `broadcast` / `reply` / `log_only` and execute

The Claude classifier costs one model call per `handoff`/`question`/`finding`, which is why the loop is opt-in. When the flag is on, `POST /threads/:id/messages` skips its escalation-task auto-create — the loop owns the full lifecycle to avoid duplicate tasks. When the flag is off, the route spawns a parked `pending` escalation task **only if the message sets `spawnTask: true`** (opt-in, default false) — so informational/coordinator escalations don't create stray tasks.

The `scheduler` option on `buildServer()` is `false` in tests to avoid background polling during test runs.

### MCP server (packages/mcp-server)

Fifteen tools with model-agnostic descriptions (work with any MCP-compatible client):
`create_task`, `commit_task`, `get_my_tasks`, `update_task_status`, `send_message`, `get_unread_messages`, `mark_thread_read`, `list_threads`, `create_thread`, `conclude_plan`, `archive_task`, `archive_thread`, `list_all_tasks`, `session_start`, `submit_review`. (`create_task` injects the caller as `createdBy`; status is derived from the assignee server-side; a worker's `create_task` is a proposal — see propose-vs-commit in the data model — and `commit_task` is the orchestrator's commit/reject of one; shell verify predicates stay orchestrator-gated — same surface the `relai task create`/`relai task commit` CLI commands expose to humans. `archive_task`/`archive_thread` hide a terminal-state task/concluded thread from the default lists + `session_start` to keep startup payloads small; history stays queryable via `archived=true`.)

Supports stdio transport (default) and HTTP/SSE transport (`TRANSPORT=http`).

**Owner mode (operator ingress).** Set `API_OWNER_TOKEN` (= the API's `SERVICE_ADMIN_TOKEN`) + `OWNER_ID=usr_…` instead of `API_SECRET`/`AGENT_ID`/`REPO_ID`, and the server exposes a separate **operator toolset** (`buildOperatorTools`) instead of the 13 agent tools: `list_attention`, `get_task`, `reply_human`, `review_task`, `commit_proposal`. These act across **all** the owner's repos (the client sends `X-Owner-Id`; the API scopes by `repos.ownerId`), addressing each resource by id — no `repoId` argument. `reply_human` posts to a thread as `fromAgent="human"`, which is what the blocked-task watcher keys on to resume a stalled task, so it's the remote unblock primitive. Heartbeat/inbox polling are skipped (no single agent identity). See `docs/operator-ingress.md`.

**MCP SDK version**: pinned to `1.6.0`. v1.29+ adds an `execution.taskSupport` field to tool definitions that Claude Code v2.x does not recognize, causing tools to be silently excluded from the deferred tool list even when the server is connected. Do not upgrade past 1.6.0 without testing.

**Tool handler return format**: all handlers must return `{ content: [{ type: "text", text: string }] }`. The SDK does not automatically wrap plain object returns — returning a plain object results in the tool appearing to succeed but delivering no content to the model.

**Zod defaults on `.shape`**: `server.tool()` receives the Zod schema's `.shape`, not the full schema object. This means `.default()` values on fields are not applied at call time. Always apply defaults manually in the handler (e.g. `const status = input.status ?? "assigned"`).

### CLI (packages/cli)

The `relai` binary is the operator surface. It reads its config from `~/.config/relai/config.json` (override the dir with `RELAI_CONFIG_DIR` for solo multi-identity testing).

**Setup**
- `relai init` — interactive first-time setup: prompts for API URL + admin secret, creates a repo (or accepts an existing repo ID), registers an agent, saves the per-agent token, prints the `.mcp.json` snippet
- `relai login --invite <code> [--api <url>]` — accept a repo invite as a new agent (defaults `workerType: "human"`); refuses to clobber an existing config
- `relai token rotate` / `relai token revoke <tokenId>`

**Discovery**
- `relai repos` — list repos on the server
- `relai repo show [id]` — show the current (or specified) repo's details
- `relai agents` — list agents in the current repo (online indicator + you marker)
- `relai status` — agent identity, online agents, task summary, unread count
- `relai watch [--kinds <list>]` — stream live SSE events you're subscribed to (new tasks, messages, reviews, verifications) until Ctrl-C, with reconnect/backoff. Self-subscribes to your own agent-target on startup (idempotent) so task-assignment events surface, which a plain `/events` subscription otherwise misses. Live-only; missed events are in `relai start`.

**Tasks**
- `relai tasks [--all] [--status ...]` — list (default: your assigned + in_progress)
- `relai task create [-t -d -p --to <agent|@auto> --domains --specialization --verify-kind <kind> --verify-reviewer <agent> ...]` — verifier flags: `--verify` (shell), `--verify-kind file_exists --verify-path`, `--verify-kind thread_concluded --verify-thread`, `--verify-kind reviewer_agent --verify-reviewer` (or shorthand `--review-by <agent>`)
- `relai task start|done|block|cancel <id> [--note ...]`
- `relai task review <id> --decision approve|reject [--note ...]` — submit a reviewer-agent decision (caller must be the named reviewer)
- `relai task commit <id> [--to <agent|@auto>] [-t --title] [-p --priority] [--reject] [--note ...]` — orchestrator commits a worker's `proposed` task into the lifecycle (or `--reject` to cancel it). `relai inbox` lists proposals awaiting commit when you're an orchestrator.

**Threads & messages**
- `relai threads`, `relai thread new <title>`
- `relai send <threadId> [-m -t --to <agent|@auto>]` — `--to` accepts agent name or ID
- `relai inbox [-r]` — unread messages plus any tasks awaiting your review (when you're the named `verifyReviewerId` on a `pending_verification` task)

**Repo ops**
- `relai repo invite [-n -s --ttl ...]` — issue a one-time invite code for `relai login`

The `--to <name>` flag in both `task create` and `send` resolves through `packages/cli/src/lib/resolve.ts` (case-insensitive name match; passes through `agent_*` IDs and the literal `@auto`).

**Non-interactive mode.** The global `--no-input` flag (or `RELAI_NO_INPUT=1`, or a non-TTY stdin) suppresses every prompt. Defaults: `task create` uses `priority=normal`; `send` uses `type=status`. Required-without-default fields (`task create` title/description, `send` body) fail fast with exit code 2 and a hint at the missing flag instead of opening a prompt — making the CLI scriptable from CI or pipes.

### MCP client configuration

Add the snippet from `relai init` (or `relai login`) to `.mcp.json` in the repo root (repo-level) or `~/.claude.json` (global). Repo-level is preferred — it keeps each repo's agent identity isolated. The snippet wires the per-agent token into `API_SECRET` for the MCP server, which sends it as the bearer credential.

**Tool slot limit**: Claude Code exposes a finite number of MCP tools per session. If you have many MCP servers, the relai tools may not surface. Disable unused MCP servers or move relai to `~/.claude.json` to prioritize it. The tools are working correctly if `/mcp` shows relai as connected with thirteen tools.

**Repo path**: Relai stores `repoPath` on the agent record and shows it in setup instructions, but cannot enforce it for interactive sessions. Always start your agent session from the correct directory — the agent will work in whatever directory it was launched from.

## Testing

Tests use vitest. Test files live alongside source as `*.test.ts`.

Currently tested:
- `packages/api/src/routes/api.test.ts` — full route coverage with `app.inject()` against a real Postgres
- `packages/api/src/routes/auth.test.ts` — token resolution, deprecated-secret fallback, whitelist
- `packages/api/src/routes/invites.test.ts` — invite create + accept + expiry
- `packages/api/src/routes/events.test.ts` — SSE subscription fan-out + persisted-event side effects
- `packages/api/src/routes/session.test.ts` — `/session/start` bundle (tasks, unread, threads, recentEvents)
- `packages/api/src/routes/propose-commit.test.ts` — propose-vs-commit: worker creates land in `proposed`, orchestrator/admin commit directly, and `POST /tasks/:id/commit` (assign/@auto/default, ratified edits, reject, 403/409/404, verify re-validation)
- `packages/api/src/routes/notification-channels.test.ts` — webhook fan-out, HMAC signing, retry/backoff, circuit breaker
- `packages/api/src/lib/router/scheduler.test.ts` — stall detection
- `packages/api/src/lib/router/verify-scheduler.test.ts` — verification predicate execution and stuck-claim recovery
- `packages/api/src/lib/verify.test.ts` — shell predicate executor (timeout, stdout/stderr cap)
- `packages/api/src/lib/verify-file-exists.test.ts` — file_exists predicate (absolute, missing, relative-to-cwd)
- `packages/api/src/lib/verify-thread-concluded.test.ts` — thread_concluded predicate (concluded, open, missing)
- `packages/api/src/lib/verify-reviewer-agent.test.ts` — reviewer_agent predicate (approve, reject)
- `packages/api/src/lib/router/rules.test.ts` — rules-based routing logic
- `packages/api/src/lib/router/message-loop.test.ts` — handoff/finding/decision/question/escalation handling in the API's in-process loop
- `packages/mcp-server/src/tools.test.ts` — MCP tool handlers with mocked API client

Total ~339 tests across the workspace (api alone: ~201). When adding routes, update `api.test.ts`. When adding routing rules, update `rules.test.ts`. When adding or modifying MCP tools, update `tools.test.ts` — especially verify the content format and any default-value handling.

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
| `REVIEW_OVERDUE_MS` | `600000` | How long a `reviewer_agent` task may sit in `pending_verification` awaiting a decision before the verify scheduler emits a one-time `task.review_overdue` event (notifies the reviewer + task subscribers). |
| `PROPOSED_OVERDUE_MS` | `600000` | How long a worker's `proposed` task may sit awaiting an orchestrator's commit before the scheduler emits a one-time `task.proposed_overdue` event (notifies the repo's orchestrators). |
| `ENABLE_MESSAGE_ROUTING` | `false` | When `true`/`1`, the API scheduler runs the in-process message loop per tick (handoff/question/finding via Claude; escalation/decision via rules). Costs a Claude call per inbound handoff/question/finding. |
| `AGENT_ID` | — | Set after registering an agent |
| `REPO_ID` | — | Set after creating a repo |
| `SERVICE_ADMIN_TOKEN` | — | Multi-tenant service-admin credential. With an `X-Owner-Id: usr_…` header it scopes API reads/writes to that owner's repos (`repos.ownerId`). The closed cloud dashboard uses it; also the owner credential for the operator ingress. |
| `API_OWNER_TOKEN` | — | MCP server owner-mode credential (= the API's `SERVICE_ADMIN_TOKEN`). When set, the MCP server runs the operator toolset across all the owner's repos instead of the per-agent tools. See `docs/operator-ingress.md`. |
| `OWNER_ID` | — | MCP owner-mode user id (`usr_…`); required alongside `API_OWNER_TOKEN`. Sent as `X-Owner-Id`. |
| `RELAI_CONFIG_DIR` | `~/.config/relai` | Override CLI config location (multi-identity testing) |
| `RELAI_SKIP_REPO_CHECK` | — | Escape hatch for the repo-access guard. When set, CLI login / MCP agent-mode / the workers skip the "you must be in a clone of this agent's repo" check. |

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
API_SECRET=<your-secret> tsx scripts/seed.ts my-repo my-agent orchestrator
pnpm --filter @getrelai/web dev        # terminal 3
```

Then open http://localhost:5173, enter the API URL and secret.

For a coworker joining an existing repo, see `docs/two-person-test.md`: the host runs `relai repo invite`, the coworker runs `relai login --invite <code>`.

## Git remote / PR workflow

This repo lives under the personal `phillipsio` org on github.com. Local git is wired to push via the `github-personal` SSH host alias (`git@github-personal:phillipsio/relai.git`), which routes through the personal SSH key. **`git push` works normally** — no extra steps.

The local `gh` CLI is authenticated against the **work** account (Enterprise Managed User) and **cannot** create PRs against `phillipsio` repos — `gh pr create` fails with `Unauthorized: As an Enterprise Managed User, you cannot access this content`. Do not retry with different flags; the auth is the limit.

Workflow:
1. Branches are optional — used for isolation when worktrees are involved, not for review. Push direct to `main` is fine on this repo (solo personal project; the user owns it).
2. If you do work on a branch, fast-forward or `--no-ff` merge into `main` locally, then `git push origin main`. No PR ceremony needed.
3. The Claude Code auto-mode classifier may still flag direct-to-main pushes; if blocked, surface the block — the user has standing authorization and will approve.

`gh pr create` will not work against `phillipsio/*` repos because the local `gh` is bound to the work account (Enterprise Managed). Don't try.

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
