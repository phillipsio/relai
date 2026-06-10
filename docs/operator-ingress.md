# Operator ingress — command relai from your phone

Every other relai identity is project-scoped: an agent token = one project. The
**operator ingress** is a single *owner* identity that acts across **all** your
projects, driven by a remote/mobile Claude session. The motivating use case:
you're out, an urgent issue lands, you tell Claude on your phone, and it
dispatches into the right project — most importantly, it can **unblock** a
stalled worker.

This is not an autonomous meta-orchestrator. Phone-Claude is the brain; relai
just lets one identity you command reach across projects.

## How it works

The operator surface is built almost entirely from machinery relai already has:

- **Owner identity.** The API authenticates an owner via the service-admin token
  plus an `X-Owner-Id: usr_…` header (`packages/api/src/plugins/auth.ts`). Owner
  requests are scoped to projects where `projects.ownerId` matches — list reads
  filter to owned projects, and `assertProjectAccess()` gates every write.
- **Unblock = a human reply.** The blocked-task watcher
  (`packages/api/src/lib/router/scheduler.ts`) resumes any `blocked` task the
  moment a message on its `metadata.blockedThreadId` thread is from `"human"`
  and newer than the task — capturing your reply into `metadata.humanReply`. So
  unblocking is just posting a reply as `human` on the blocking thread; no
  special lifecycle endpoint. Owner-authenticated posts to
  `POST /threads/:id/messages` are stamped `fromAgent="human"` server-side.
- **Decisions reuse existing endpoints.** Review approve/reject
  (`POST /tasks/:id/review`), proposal commit/reject (`POST /tasks/:id/commit`).

### Operator MCP toolset (owner mode)

Run the MCP server in **owner mode** (set `API_OWNER_TOKEN` + `OWNER_ID` instead
of `API_SECRET` + `AGENT_ID` + `PROJECT_ID`). It then exposes a small operator
toolset instead of the 13 per-agent tools. Each tool addresses a resource by id,
so no `projectId` argument is needed — the owner token scopes everything.

| Tool | Purpose | Underlying call |
|---|---|---|
| `list_attention` | Everything across your projects that needs you: `blocked`, `pending_verification`, `proposed`. Each task carries its `projectId` and, when blocked, its `blockedThreadId`. | `GET /tasks?status=…` |
| `get_task` | Full detail of one task before you act (the worker's question, metadata). | `GET /tasks/:id` |
| `reply_human` | The unblock primitive — reply on a task's `blockedThreadId`; the watcher resumes the worker with your answer. | `POST /threads/:id/messages` (recorded as `human`) |
| `review_task` | Approve/reject a reviewer-gated task in `pending_verification`. | `POST /tasks/:id/review` |
| `commit_proposal` | Commit (assign) or reject a worker's `proposed` task. | `POST /tasks/:id/commit` |

## Setup

### 1. Deploy relai with the MCP server reachable over HTTP

Deploy the API (see [`deploy-fly.md`](./deploy-fly.md)) and run the MCP server
with `TRANSPORT=http` so a remote client can connect. Owner-mode env:

```bash
API_URL=https://<your-relai-api>        # the deployed API
API_OWNER_TOKEN=<service-admin token>   # = the API's SERVICE_ADMIN_TOKEN
OWNER_ID=usr_<your-user-id>             # the users.id you own projects under
TRANSPORT=http
MCP_PORT=3001
```

> **The HTTP/SSE transport is unauthenticated.** It accepts any `GET /sse` /
> `POST /messages` with no credential check, and in owner mode the process
> itself holds the `API_OWNER_TOKEN` god key and does all upstream auth — so
> reaching `MCP_PORT` *is* possession of the key. The server therefore binds to
> `127.0.0.1` by default (override only deliberately via `MCP_HOST`). To reach
> it remotely, put an **authenticating** layer in front (a Cloudflare Tunnel +
> Access policy, an authenticating reverse proxy, or a private VPN/Tailscale
> network) — never bind it to `0.0.0.0` / expose `MCP_PORT` to the public
> internet directly.

### 2. Make sure your projects have an owner

`projects.ownerId` is null for self-hosted projects created via the legacy
`API_SECRET` path. For the operator ingress to see them, create (or back-fill)
projects under your `users` row so `ownerId` is set. Projects created through
the service-admin path (service-admin token + `X-Owner-Id`) are stamped
automatically.

### 3. Register relai as a remote MCP connector in claude.ai

Add the deployed MCP endpoint as a custom/remote MCP connector in claude.ai
(works on mobile), authenticated with the owner credential. Once connected, the
operator tools are available to any session — including your phone.

## Operating principle: echo before you act

Reads are free; **writes confirm**. The failure mode here isn't a crash — it's
resuming a worker (or approving a review) on a *misread* verbal instruction from
your phone while you're distracted. Phone-Claude should always show the exact
reply/decision it's about to post and wait for your confirmation before calling
`reply_human` / `review_task` / `commit_proposal`. Everything the owner does is
recorded as `human` in the event/verification trail, so the thread reads
correctly when you're back at your desk.

## Security note (the credential)

v1 reuses `SERVICE_ADMIN_TOKEN` as the owner credential. That token is a **god
key** — with a different `X-Owner-Id` it can act as any owner — and it lives on
your phone. For a single-operator self-hosted box that's an acceptable tradeoff,
but: keep the token short-lived and rotate readily. Two distinct exposures to
keep straight:

1. **The token on your phone.** Treat it like any root credential; rotate on
   loss.
2. **The owner-mode MCP server itself.** Because the HTTP transport is
   unauthenticated and the server carries the god key internally (see Setup
   step 1), reaching its port *is* possession of the key. The authenticating
   layer in front of it is what actually protects you — not the token's secrecy.

A dedicated scoped owner-token type (resolves to a fixed `users.id`, can't
impersonate others) and requiring the credential on the `/sse` handshake are the
intended follow-ups that would let the transport defend itself.

## Related: in-worker subagent fan-out

Spawning reviewers/doc-writers for a relai task is a **worker-side** concern, not
a server feature. `claude-worker` runs a full Claude session in the repo, so it
can fan out subagents via its own workflow/skills in `.claude/`. Keep an explicit
**concurrency cap** in that workflow so a worker never spawns hundreds of
subagents, and remember the fan-out spends your Claude subscription capacity —
the same pool as your interactive usage.
