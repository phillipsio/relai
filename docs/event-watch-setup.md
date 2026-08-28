# Setup: event-driven relai watch in an interactive agent session

Make an already-running Claude Code agent listen for relai events (new tasks
assigned to it, messages) while it works normally, and auto-start that listener
on every session. Zero idle model cost: the watcher blocks as a background
process and the harness re-invokes the agent when that process ends. A real event
is one way it ends; an external kill is the other (see Two kinds of wake below).

This is "Mode 2" from `docs/plan-event-driven-agent-watch.md`. For a standalone
headless daemon with no interactive session, use the `event-worker` package instead.

## Pieces (all live in the relai repo)

- `scripts/relai-stream-wait.sh` — self-subscribes, then blocks on `GET /events`
  for one connection window and prints the first real event. Takes the token from
  `RELAI_TOKEN` in the environment, not argv, because `ps` exposes arguments.
- `scripts/relai-watch.sh` — wake-loop wrapper: resolves config, reconnects across
  heartbeats/timeouts/drops, and never ends itself for less than a genuine event.
  This is what the agent launches.
- `scripts/relai-watch-hook.sh` — SessionStart hook: injects the instruction to
  launch the watcher (a hook can't issue a tool call itself).

## Install into a consumer repo

The consumer repo (the one whose agent should listen) needs one settings entry.
Add to its `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/github/relai/scripts/relai-watch-hook.sh" }
        ]
      }
    ]
  }
}
```

That's it. On every session start the hook checks the repo has a `relai` server
in its `.mcp.json`; if so it tells the agent to launch `relai-watch.sh` in the
background and follow the wake loop.

**The relai repo itself is a consumer and needs this too.** It was the last one
wired up (2026-08-25), which meant relai's own orchestrator was the only agent in
the fleet that never woke on an event, and it then inferred from its own silence
that no agent did. The hook self-gates on `.mcp.json`, so committing it is safe
even for a clone with no relai credentials.

### Token sourcing (plan Q3, resolved)

`relai-watch.sh` resolves `API_URL` / `API_SECRET` / `AGENT_ID` from, in order:
1. the environment, then
2. the `mcpServers.relai.env` block of the repo's `.mcp.json` (the same per-agent
   token the MCP server already uses).

So no secret is placed in the launch command or the agent's context. If relai
lives somewhere other than `~/github/relai`, set `RELAI_DIR` in the hook command's
environment.

## Manual launch (no hook)

To test, or to start it by hand inside any agent session, run via Bash with
`run_in_background: true`:

```bash
$HOME/github/relai/scripts/relai-watch.sh
```

When it ends, read the background output before anything else, then follow
**Two kinds of wake** below.

## Two kinds of wake

The harness re-invokes the agent whenever the background task ends, and two very
different things end it. Telling them apart is worth a full turn.

| Output | What happened | What to do |
|---|---|---|
| contains relai event JSON | a real event | call `session_start`, handle what's new, relaunch |
| no event JSON | the background task was killed | relaunch and resume; do **not** call `session_start` |

Decide on the event JSON alone, never on the exact shape of a kill. A reap usually
leaves `[killed]` and nothing else, but a child dying on a signal also leaves a shell
job-status line (`Abort trap: 6` was seen on 2026-08-28, 212 bytes instead of 10). That
is still a kill. Matching "empty or `[killed]`" leaves that output in neither case.

Claude Code reaps background tasks on a recurring timer whose phase is per
session, so a reap is routine and carries no information. Measured 2026-08-27:
five reaps for one agent 30 minutes apart to the second. Reconciling on one costs
a turn and finds nothing, which is why `relai-watch-hook.sh` injects the split
rather than an unconditional `session_start`.

Removing the reap means supervising the watcher outside the harness (launchd), but
a background-task exit is currently the only thing that can start a turn in an
interactive session, so that trades the spurious wake for no wake at all. It is
gated on a doorbell channel that can start a turn directly.

## Tunables (env vars)

| Var | Default | Meaning |
|---|---|---|
| `RELAI_DIR` | `~/github/relai` | relai checkout location (hook) |
| `RELAI_WATCH_WINDOW` | `590` | seconds per SSE connection before a silent reconnect |
| `RELAI_WATCH_BACKOFF` | `2` | seconds to wait after a timeout/drop before reconnecting |
