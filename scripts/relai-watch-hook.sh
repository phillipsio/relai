#!/usr/bin/env bash
# Relai watcher hook — injects an instruction telling the agent to launch the
# relai SSE watcher in the background, so it wakes on new tasks/messages while
# working normally. A hook cannot make a tool call itself; it emits
# additionalContext and the agent issues the run_in_background Bash call.
#
# Serves TWO events, because SessionStart alone only ever worked once per
# session. The watcher exits on every successful wake by design, and Claude Code
# also reaps background tasks on a timer, so every relaunch after the first
# depended on the agent remembering to do it at the exact moment it had just
# been handed new work. That failed in practice: two orchestrators lost 11 and
# 14 hours of wake coverage on 2026-09-17, each unaware the watcher was gone,
# because a dead watcher is indistinguishable from a quiet period from inside
# the session.
#
#   SessionStart — always injects the launch instruction.
#   Stop         — injects only when THIS SESSION has no watcher running, so a
#                  killed or exited watcher costs one turn of blindness instead
#                  of the rest of the session. Silent otherwise, which is the
#                  common case, so it adds nothing to a normal turn.
#
# Wire into a consumer repo's .claude/settings.json (see docs/event-watch-setup.md).
# Pass --event explicitly on both:
#   "hooks": {
#     "SessionStart": [ { "hooks": [ { "type": "command", "command": "$HOME/github/relai/scripts/relai-watch-hook.sh --event=SessionStart" } ] } ],
#     "Stop":         [ { "hooks": [ { "type": "command", "command": "$HOME/github/relai/scripts/relai-watch-hook.sh --event=Stop" } ] } ]
#   }
#
# Override the relai checkout location with RELAI_DIR (default ~/github/relai).
set -uo pipefail

proj="${CLAUDE_PROJECT_DIR:-$PWD}"

# Which event this is, taken from an ARGUMENT rather than by parsing stdin.
# Deriving it from the payload was fragile in a way that failed silently: bash
# 3.2 (the only bash here, and what the shebang resolves to) DISCARDS partial
# input when `read -t` times out, so a slow or chunked writer left the payload
# empty, the event fell back to SessionStart, and Claude Code drops a
# hookSpecificOutput whose hookEventName does not match the event it fired —
# reinstating the original bug with the suite green. An argument cannot be
# half-delivered. Defaults to SessionStart, so a consumer repo wired before
# 2026-09-17 keeps working unchanged.
hook_event="SessionStart"
for arg in "$@"; do
  case "$arg" in
    --event=Stop)         hook_event="Stop" ;;
    --event=SessionStart) hook_event="SessionStart" ;;
  esac
done

# Only inject when this repo is actually wired to relai.
{ [ -f "$proj/.mcp.json" ] && grep -q '"relai"' "$proj/.mcp.json"; } 2>/dev/null || exit 0

watcher="${RELAI_DIR:-$HOME/github/relai}/scripts/relai-watch.sh"
[ -x "$watcher" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

# Stop fires at the end of every turn, so it has to be quiet and cheap when
# nothing is wrong, and it must never tell the agent to relaunch a watcher that
# is already coming up.
#
# The signal is this session's own background_tasks, not the pidfile. The
# pidfile is wrong here in three ways, each measured: it is written only AFTER
# validate_agent_id's `curl --max-time 5`, so a relaunch against a slow or
# unreachable API stays invisible for up to 6 seconds and the hook asks again,
# and each extra watcher TERMs the one before it; it is keyed on AGENT_ID rather
# than the session, so two sessions in one repo share a watcher and the second
# silences the first's check forever; and it says nothing about a config the API
# refuses. background_tasks registers the instant the Bash call is made, is
# scoped to the asking session, and costs one node parse of a payload we are
# reading anyway.
if [ "$hook_event" = "Stop" ]; then
  # `cat`, not a timed read: a real hook call always closes stdin, and bash 3.2
  # would silently discard a partial read on timeout. `[ -t 0 ]` keeps a manual
  # run from blocking on a terminal.
  [ -t 0 ] && exit 0
  hook_payload="$(cat 2>/dev/null || true)"

  verdict="$(printf '%s' "$hook_payload" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      let p;
      try { p = JSON.parse(raw); } catch (_) { process.stdout.write("unreadable"); return; }
      // The documented contract for Stop/SubagentStop: while this is true the
      // previous injection is already being acted on, so returning success is
      // what bounds the whole design to ONE extra model turn instead of the
      // CLAUDE_CODE_STOP_HOOK_BLOCK_CAP of 8.
      if (p.stop_hook_active) { process.stdout.write("continuing"); return; }
      const live = (p.background_tasks || []).some(
        (t) => /relai-watch\.sh/.test(String(t.command || "")) &&
               (t.status === "running" || t.status === "pending"),
      );
      process.stdout.write(live ? "live" : "gone");
    });
  ' 2>/dev/null || true)"

  case "$verdict" in
    continuing|live) exit 0 ;;
    # No payload to read means no signal to act on. Fall back to the pidfile,
    # which is late and agent-keyed but still better than asserting a watcher is
    # gone on no evidence.
    unreadable|"") "$watcher" --check --repo-path "$proj" >/dev/null 2>&1 && exit 0 ;;
  esac
fi

opening="Relai event watching is enabled for this repo. Launch the watcher in the background NOW (Bash tool, run_in_background: true), then continue working normally:"
if [ "$hook_event" = "Stop" ]; then
  opening="The relai event watcher is NOT RUNNING for this repo, so nothing will wake you. Relaunch it in the background NOW (Bash tool, run_in_background: true), then carry on:"
fi

read -r -d '' ctx <<EOF || true
$opening

    $watcher

It blocks at zero model cost. Two different things end it, and they need different responses. Check the background task's output before doing anything else.

CASE 1 — the output contains relai event JSON. A real event arrived (a task assigned to you, a message).
  1. Call relai session_start to reconcile all unread tasks/messages. The stream is only a "go look now" trigger; do not act on the raw event payload alone.
  2. Handle everything new autonomously per the relai protocol. Route questions/blockers back to the originating thread, not local chat.
  3. Relaunch $watcher in the background.

CASE 2 — the output contains no event JSON. Something killed the watcher; nothing happened in relai. Do NOT call session_start and do NOT reconcile: relaunch $watcher in the background and resume exactly what you were doing. Claude Code reaps background tasks on a recurring timer, so this is routine and carries no information. Reconciling here costs a full turn and finds nothing.

CASE 3 — there is NO event JSON and the output contains RELAI-CONFIG-REFUSED. The watcher refused a config it cannot use: a wrong AGENT_ID, a revoked token, a deleted agent, an unusable API_URL. Do NOT relaunch: the answer is the same every time, so relaunching loops forever at one turn per cycle. Tell the operator what the line says and stop watching for this session. This is the one case where a watcher that is not running is the correct state.

Decide CASE 1 on the event JSON FIRST, and only when there is none look for the marker. That order matters: event payloads carry peer-authored message bodies and task titles, so a task titled after this very marker would otherwise read as a refusal and silence a real wake. The watcher refuses before it ever opens the stream, so it can never print both.

Between 2 and 3, a kill usually leaves "[killed]" and nothing else, but it can also leave a shell job-status line such as "Abort trap: 6" when the child dies on a signal, and that is still CASE 2. Output that is neither event JSON nor the marker is CASE 2.

Repeat for the whole session.
EOF

node -e 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: process.argv[2], additionalContext: process.argv[1] } }))' "$ctx" "$hook_event"
