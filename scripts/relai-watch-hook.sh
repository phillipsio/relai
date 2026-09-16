#!/usr/bin/env bash
# Relai SessionStart hook — injects an instruction telling the agent to launch
# the relai SSE watcher in the background, so it wakes on new tasks/messages
# while working normally. The instruction distinguishes an event exit from an
# external kill: only the former is worth a session_start. A hook cannot make a
# tool call itself; it emits additionalContext and the agent issues the
# run_in_background Bash call.
#
# Wire into a consumer repo's .claude/settings.json (see docs/event-watch-setup.md):
#   "hooks": { "SessionStart": [ { "hooks": [
#     { "type": "command", "command": "$HOME/github/relai/scripts/relai-watch-hook.sh" }
#   ] } ] }
#
# Override the relai checkout location with RELAI_DIR (default ~/github/relai).
set -uo pipefail

proj="${CLAUDE_PROJECT_DIR:-$PWD}"

# Only inject when this repo is actually wired to relai.
{ [ -f "$proj/.mcp.json" ] && grep -q '"relai"' "$proj/.mcp.json"; } 2>/dev/null || exit 0

watcher="${RELAI_DIR:-$HOME/github/relai}/scripts/relai-watch.sh"
[ -x "$watcher" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

read -r -d '' ctx <<EOF || true
Relai event watching is enabled for this repo. Launch the watcher in the background NOW (Bash tool, run_in_background: true), then continue working normally:

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

node -e 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: process.argv[1] } }))' "$ctx"
