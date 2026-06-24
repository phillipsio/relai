# Plan: event-driven agent watch (zero-idle-cost relai listening)

Status: draft / pick-up-later. Author handoff from a planning session 2026-06-23.

## The use case to solve

While working normally with a Claude Code agent (no relai polling running), the
human steps away (e.g. school pickup) without arranging anything. A coworker then
asks for a quick PR review. The human wants to create a relai task from their phone
(via the desktop-Claude relai super-user) and have the already-open work agent pick
it up and handle it — **without** having pre-started a poll loop, and **without**
`/remote-control` (org-policy-disabled on the work account).

Two sub-goals:
1. **Listen while working normally** — the agent should watch relai concurrently with
   doing real work, not in a blocking loop that occupies the session.
2. **Auto-start** — watching should begin every time Claude Code starts, so there is
   no "did I remember to start polling" failure mode. Leaving a tab open is acceptable.

## Key finding: the SSE server already exists

relai already ships a working SSE endpoint — **do not rebuild it**:

- `GET /events` — `packages/api/src/routes/events.ts`
  - Auth: **per-agent bearer token only** (rejects the legacy `API_SECRET` shared
    secret — see `events.ts` ~L10-13).
  - Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
    `Connection: keep-alive`, `X-Accel-Buffering: no`.
  - Heartbeat: ping every `HEARTBEAT_MS = 25_000`.
  - Subscribes to the in-process bus (`packages/api/src/lib/events.ts` `EventEmitter`
    singleton ~L39-40), and for each event resolves `resolveSubscribers(db, event)`
    (~L65-84), writing to the stream **only if this agent is a subscriber**.
  - Frame format: `event: <kind>\nid: <id>\ndata: <JSON>\n\n`.
- Port: **3010** (`API_PORT`, `packages/api/src/index.ts` ~L3).
- Event kinds: `task.created`, `task.updated`, `task.proposed`, `message.posted`,
  `thread.created`, etc. (`packages/api/src/lib/events.ts`).
- Persistence: every event is also written to the `events` table
  (`shared/db/src/schema.ts` ~L251-266). The bus emit is synchronous (fan-out before
  persist). `GET /session/start` already reads `recentEvents` from this table
  (`packages/api/src/routes/session.ts` ~L80-96) — this is our missed-event backfill.

Implication: the SSE stream is a **latency optimization on top of durable DB state**.
The DB (`events` table, surfaced by `session_start`) is the source of truth; the
stream just tells us *when* to go look.

## Why background, not a blocking foreground call

A foreground blocking `curl` (a normal Bash tool call) **occupies the session** — the
agent is mid-turn for the duration and cannot do real work. So a foreground wait
cannot satisfy sub-goal #1. It is also capped at the Bash tool's **600s hard limit**,
forcing a re-issue every ~10 min, and a 10-min gap blows the 5-min prompt-cache TTL —
so each re-issue is a full-context cache miss. That is *more* idle cost than 15-min
cron polling, not less.

The fix is a **background** listener (Claude Code Bash `run_in_background: true`):
- It runs detached, holding the SSE connection open at **zero model cost** while the
  agent does normal work.
- The harness **re-invokes the model when the background process exits**.
- So if the listener is written to exit *only when a real event arrives*, the model is
  woken **exactly once per real event — zero idle turns, zero idle cost**. This is what
  the foreground design claimed but could not deliver.

## Work items

### 1. (relai) Reusable listener script — the main new artifact

Add `scripts/relai-stream-wait.sh` to the relai repo (reusable by any consuming agent).
**Shipped signature:** `relai-stream-wait.sh <api_url> <token> <agent_id> [max_seconds]`
— it self-subscribes (work item #3) then blocks on the stream with `--max-time` and an
`awk` filter (no in-script reconnect loop; the caller re-launches per wake). The sketch
below is the original design; the shipped version is the source of truth.

- Connects to `GET $BASE/events` with `Authorization: Bearer $TOKEN` via `curl -sN`
  (no buffering).
- **Internally** handles heartbeats and connection drops (silent reconnect with small
  backoff) so the caller is woken ONLY by a genuine event.
- On the first real event frame, prints the event JSON (the `data:` payload) to stdout
  and exits 0.

Heartbeat format is **confirmed** (Q1 resolved, see `events.ts` L22-26): the stream
sends `: connected\n\n` on connect and `: ping\n\n` every 25s — both SSE **comment
lines** (`:`-prefixed). Real events are the only frames with a `data:` line
(L32-34: `event: <kind>` / `id: <id>` / `data: <full AppEvent JSON>`). So
`grep -m1 '^data: '` cleanly ignores heartbeats and matches only real events — no
kind-filtering needed.

```bash
#!/usr/bin/env bash
set -uo pipefail
BASE="${1:?base url e.g. http://localhost:3010}"
TOKEN="${2:?agent bearer token}"
while true; do
  # Heartbeats are ": ..." comment lines; only real events have a "data:" line.
  # --line-buffered + curl -N avoid pipe buffering delaying the wake.
  line=$(curl -sN -H "Authorization: Bearer $TOKEN" "$BASE/events" \
         | grep --line-buffered -m1 '^data: ')
  if [ -n "$line" ]; then
    printf '%s\n' "${line#data: }"   # the full AppEvent JSON
    exit 0
  fi
  sleep 2   # connection dropped / relai (Docker) restarted -> reconnect, no model wake
done
```
Notes:
- The `data:` payload is the entire `AppEvent` (`id`, `kind`, `repoId`, `targetType`,
  `targetId`, `alsoNotify`, `payload`, `createdAt`) — enough to know what fired, but the
  agent should still reconcile via `session_start` on wake (loop contract step 3a).
- relai runs in Docker locally and has been observed to go down and take the stream
  with it. The reconnect loop covers that; `sleep 2` is the backoff. A dropped
  connection gives `grep` EOF → empty `line` → silent reconnect (no model wake).
- `curl -sN` (no buffering) + `grep --line-buffered` ensure the match flushes
  immediately rather than sitting in a pipe buffer.

### 2. (consumer repo) Auto-start hook + wake-loop instructions

These live in the consuming repo (e.g. `functionize-mcp-go`), not relai, but are
documented here for cohesion.

- **SessionStart hook** (`.claude/settings.json` `hooks.SessionStart`): on every Claude
  Code start for the repo, inject `additionalContext` instructing the agent to launch
  the watcher in the background immediately. (A hook cannot issue a tool call itself —
  it injects the instruction; the agent makes the `run_in_background` call. This is more
  reliable than a passive AGENTS.md line, which is model-discretion.)
- **AGENTS.md** documents the loop so it survives context compaction.

The wake-loop contract the agent follows:
1. At session start (prompted by the hook), launch
   `scripts/relai-stream-wait.sh <base> <token>` via Bash `run_in_background: true`.
2. Continue doing normal work — the listener is detached.
3. When the listener exits (a real event arrived), the harness re-invokes the agent.
   The agent then:
   a. Calls `session_start` FIRST — this reconciles ALL unread messages / new tasks /
      recent events from the DB, covering anything missed while disconnected or between
      exit and relaunch. **Do not act on the single SSE payload alone.**
   b. Handles everything new autonomously per the relai autonomy protocol (act solo;
      route questions/blockers back to the originating thread).
   c. Relaunches the listener in the background. Repeat.

### 3. (relai) Confirm the watch agent receives the right events — RESOLVED

`GET /events` only streams events for which this agent is a subscriber
(`resolveSubscribers`, `packages/api/src/lib/events.ts` ~L65-84). Verified:
- `message.posted` with `toAgent = <agent>` — `ensureSubscription` is called for the
  recipient, so this arrives.
- `task.created`/`task.committed`/`task.updated` assigned to the agent — these fan out
  via `alsoNotify: [{ targetType: "agent", targetId: assignedTo }]` (`tasks.ts` ~L242,
  L384, L480, L630), **but the assignee is never auto-subscribed to its own
  agent-target.** `ensureSubscription` in `tasks.ts` only subscribes the *creator* and
  the repo's *orchestrators* to the task — not the assignee to themselves. So without a
  self-subscribe the listener never receives new tasks assigned to it: the exact events
  this feature exists to catch. `relai watch` already works around this (`watch.ts`
  ~L135-141); the watcher must do the same.

Fix (shipped): both the `event-worker` package and `relai-stream-wait.sh` self-subscribe
to their own agent-target (`POST /subscriptions { agentId, targetType:"agent", targetId:
agentId }`, idempotent server-side) before opening the stream.

### 4. Token sourcing

The watcher needs the agent's bearer token (same one the MCP server uses). Decide where
the hook/script reads it from (env var, the MCP server config, or a file). Do not
hardcode. Document in the consumer repo.

### 5. End-to-end test

1. Start the listener in the background in one session.
2. From a second session (or the desktop relai super-user), create a task assigned to
   the agent / send it a message.
3. Confirm the background process exits within ~1s and the agent wakes, runs
   `session_start`, and handles the item.
4. Kill relai (Docker) mid-listen; confirm the script reconnects silently and still
   catches a post-restart event without waking the model on the drop.

## Robustness checklist

- **Missed events:** always reconcile via `session_start` on wake (the stream can drop;
  the DB is authoritative). Covered by the loop contract step 3a.
- **Reconnect:** the script's loop handles Docker/network drops; no model wake on drop.
- **Heartbeat:** ignore heartbeats (Q1); only real event frames wake the model.
- **Duplicate wakes:** harmless — `session_start` is idempotent reconciliation; mark
  threads read after handling.

## Out of scope / Phase 2

- **Closed-session coverage.** The background listener dies when Claude Code closes. If
  the human wants work handled even with NO Claude session open, that needs an OS-level
  daemon (macOS `launchd`) running a headless watcher that, on a relai event, fires
  `claude -p "<handle this relai task>"` as a non-interactive run. This removes the
  "leave a tab open" precondition entirely and still needs no `/remote-control`. Spec
  separately if "leave a tab open" proves insufficient.
- **Horizontal scaling.** The in-process `EventEmitter` bus means SSE subscribers on one
  API instance won't see events published on another. For local single-instance use this
  is fine. If relai is ever scaled out, replace the bus with Postgres `LISTEN/NOTIFY` or
  Redis pub/sub (already flagged in `events.ts` ~L37-38). Not needed for this use case.

## Open questions to resolve first

- **Q1 — heartbeat format. RESOLVED (2026-06-23).** `events.ts` sends `: connected\n\n`
  on connect and `: ping\n\n` every 25s — both SSE comment lines. Real events are the
  only frames with a `data:` line. So `grep -m1 '^data: '` is sufficient; the listener
  script above is final on this point.
- **Q2 — subscription scope. RESOLVED (2026-06-23).** Per-target is the right scope, but
  the assignee is NOT auto-subscribed to its own agent-target, so a self-subscribe on
  startup is mandatory (see work item #3). Both watchers now do this. A "subscribe to my
  whole repo" stream (to see tasks created but not yet assigned to me) is not needed for
  this use case — the orchestrator already gets `task.proposed`/`task.created` via its own
  subscriptions, and a worker only acts on what's assigned to it.
- **Q3 — token sourcing.** Where does the watcher read the agent bearer token from?

## File reference (for whoever implements)

- SSE endpoint: `packages/api/src/routes/events.ts`
- Event bus + publish + subscriber resolution: `packages/api/src/lib/events.ts`
- Events table schema: `shared/db/src/schema.ts` (events ~L251-266, subscriptions ~L202-210)
- Auth (per-agent bearer): `packages/api/src/plugins/auth.ts`
- session_start backfill query: `packages/api/src/routes/session.ts` (~L80-96)
- Route/SSE test patterns: `packages/api/src/routes/events.test.ts`, `session.test.ts`
- New listener script goes in: `scripts/` (relai repo)
- Consumer hook + AGENTS.md: the consuming repo (e.g. `functionize-mcp-go`)
