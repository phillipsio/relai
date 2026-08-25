# Setup: event-driven relai watch in an interactive agent session

Make an already-running Claude Code agent listen for relai events (new tasks
assigned to it, messages) while it works normally, and auto-start that listener
on every session. Zero idle model cost: the watcher blocks as a background
process and the harness re-invokes the agent only when a real event arrives.

This is "Mode 2" from `docs/plan-event-driven-agent-watch.md`. For a standalone
headless daemon with no interactive session, use the `event-worker` package instead.

## Pieces (all live in the relai repo)

- `scripts/relai-stream-wait.sh` — self-subscribes, then blocks on `GET /events`
  for one connection window and prints the first real event. Takes the token from
  `RELAI_TOKEN` in the environment, not argv, because `ps` exposes arguments.
- `scripts/relai-watch.sh` — wake-loop wrapper: resolves config, reconnects across
  heartbeats/timeouts/drops, exits **only** on a genuine event. This is what the
  agent launches.
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

When it exits, call `session_start`, handle what's new, and relaunch it.

## Tunables (env vars)

| Var | Default | Meaning |
|---|---|---|
| `RELAI_DIR` | `~/github/relai` | relai checkout location (hook) |
| `RELAI_WATCH_WINDOW` | `590` | seconds per SSE connection before a silent reconnect |
| `RELAI_WATCH_BACKOFF` | `2` | seconds to wait after a timeout/drop before reconnecting |
