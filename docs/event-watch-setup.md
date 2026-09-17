# Setup: event-driven relai watch in an interactive agent session

Make an already-running Claude Code agent listen for relai events (new tasks
assigned to it, messages) while it works normally, and auto-start that listener
on every session. Zero idle model cost: the watcher blocks as a background
process and the harness re-invokes the agent when that process ends. A real event
is one way it ends; an external kill is the other (see Three kinds of wake below).

This is "Mode 2" from `docs/plan-event-driven-agent-watch.md`. For a standalone
headless daemon with no interactive session, use the `event-worker` package instead.

## Pieces (all live in the relai repo)

- `scripts/relai-stream-wait.sh` — self-subscribes, then blocks on `GET /events`
  for one connection window and prints the first real event. Takes the token from
  `RELAI_TOKEN` in the environment, not argv, because `ps` exposes arguments.
- `scripts/relai-watch.sh` — wake-loop wrapper: resolves config, reconnects across
  heartbeats/timeouts/drops, and never ends itself for less than a genuine event.
  This is what the agent launches.
- `scripts/relai-watch-hook.sh` — the hook, serving **both** SessionStart and Stop:
  injects the instruction to launch the watcher (a hook can't issue a tool call
  itself). On SessionStart it always injects; on Stop it injects only when no
  watcher is live for this agent, via `relai-watch.sh --check`.

## Install into a consumer repo

The consumer repo (the one whose agent should listen) needs two settings entries,
the same script on both events. Add to its `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/github/relai/scripts/relai-watch-hook.sh --event=SessionStart" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/github/relai/scripts/relai-watch-hook.sh --event=Stop" }
        ]
      }
    ]
  }
}
```

On every session start the hook checks the repo has a `relai` server in its
`.mcp.json`; if so it tells the agent to launch `relai-watch.sh` in the
background and follow the wake loop.

**Wire Stop as well as SessionStart, or the watcher runs once and stops.** This is
not belt-and-braces. The watcher exits on every successful wake by design, and
Claude Code also reaps background tasks on a timer, so SessionStart alone covers
exactly the first launch of a session and every relaunch after it depends on the
agent remembering to do so at the moment it has just been handed new work. That
failed in practice on 2026-09-17: two orchestrators lost 11 and 14 hours of wake
coverage, each unaware, because a dead watcher is indistinguishable from a quiet
period from inside the session. The Stop hook turns the worst case into one turn
of blindness.

**Pass `--event` explicitly.** The hook used to infer the event by parsing the
payload on stdin, which failed silently: bash 3.2 discards partial input when a
timed read expires, so the event fell back to `SessionStart`, and Claude Code
DROPS a `hookSpecificOutput` whose `hookEventName` does not match the event it
fired. An argument cannot be half-delivered. A repo wired without `--event`
still behaves as it did before 2026-09-17, defaulting to SessionStart.

**What Stop decides on: this session's `background_tasks`, not the pidfile.**
The Stop payload lists in-flight background work with each task's `command`, so
a watcher registers there the instant the Bash call is made. The pidfile is the
wrong signal in three measured ways: it is written only after
`validate_agent_id`'s `curl --max-time 5`, so a relaunch against a slow or
unreachable API stays invisible for up to 6 seconds while the hook asks again
and each new watcher TERMs the last; it is keyed on `AGENT_ID` rather than the
session, so two sessions in one repo share a watcher and the second silences the
first's check permanently; and it says nothing about a config the API refuses.
It is still the fallback when no payload can be read, because a late signal beats
asserting a watcher is gone on no evidence.

**The hook honours `stop_hook_active`.** While that is true the previous
injection is already being acted on, so the hook returns success. Without it any
state that stays "gone" across a continuation multiplies by
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (8) and ends in a user-visible "a hook blocked
the turn from ending 8 consecutive times": a revoked token, a denied background
Bash call, a failed pidfile write.

Cost when nothing is wrong: one `node` parse of a payload already on stdin, and
no subprocess beyond it. When it does speak, `additionalContext` on Stop
continues the conversation, so it costs one extra model turn — which is the
point, and why it must stay silent otherwise.

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
**Three kinds of wake** below.

## Three kinds of wake

The harness re-invokes the agent whenever the background task ends, and three very
different things end it. Telling them apart is worth a full turn.

| Output | What happened | What to do |
|---|---|---|
| contains relai event JSON | a real event | call `session_start`, handle what's new, relaunch |
| no event JSON, and contains `RELAI-CONFIG-REFUSED` | a config the watcher cannot use | do **not** relaunch; tell the operator and stop |
| neither | the background task was killed | relaunch and resume; do **not** call `session_start` |

Decide on the event JSON FIRST, and only when there is none look for the marker.
That order matters: event payloads carry peer-authored message bodies and task titles,
so a task named after the marker would otherwise read as a refusal and silence a real
wake. The watcher refuses before it opens the stream, so it never prints both.

The watcher emits the marker for any config it cannot use: an unusable `API_URL`, a
control character or bad shape in a credential, credentials it could not resolve at
all, or `GET /agents/:id` answering 401, 403 or 404 (wrong id, revoked token, deleted
agent). None of those clears on a retry, so relaunching loops forever at one model turn
per cycle. That is the only case where a watcher that is not running is correct.

A passing check does NOT prove the token belongs to that `AGENT_ID`: `GET /agents/:id`
answers 200 for any agent in the same repo, so a sibling's id pasted into the config
still passes. It proves the id exists and the token works, nothing more.

Between the other two, decide on the event JSON alone, never on the exact shape of a kill. A reap usually
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
