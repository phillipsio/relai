#!/usr/bin/env bash
# Relai SessionStart hook — injects an instruction telling the agent to launch
# the relai SSE watcher in the background, so it wakes on new tasks/messages
# while working normally. A hook cannot make a tool call itself; it emits
# additionalContext and the agent issues the run_in_background Bash call.
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

It blocks at zero model cost and exits only when a real relai event arrives (a task assigned to you, a message). When it exits and you are re-invoked:
  1. Call relai session_start FIRST to reconcile all unread tasks/messages — the stream is only a "go look now" trigger; do not act on the raw event payload alone.
  2. Handle everything new autonomously per the relai protocol — route questions/blockers back to the originating thread, not local chat.
  3. Relaunch $watcher in the background. Repeat for the whole session.
EOF

node -e 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: process.argv[1] } }))' "$ctx"
