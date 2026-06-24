#!/usr/bin/env bash
# Block on relai's SSE event stream until a real event arrives (or the window
# elapses), then print the event JSON and exit. The API sends a ": ping" comment
# every 25s to keep the connection alive — those are ignored; only a real `data:`
# line ends the wait. Costs nothing while blocked: this is a tool call, not a
# model turn.
#
# Self-subscribes to the agent's own agent-target first: task-assignment events
# fan out via that target (alsoNotify), but agents aren't auto-subscribed to
# themselves, so without this the stream never delivers new tasks assigned to
# us — the exact events this is meant to catch. The route is idempotent.
#
# Usage: relai-stream-wait.sh <api_url> <token> <agent_id> [max_seconds]
set -uo pipefail

API_URL="$1"
TOKEN="$2"
AGENT_ID="$3"
MAX_SECONDS="${4:-590}"

curl -sS -o /dev/null \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$API_URL/subscriptions" \
  -d "{\"agentId\":\"$AGENT_ID\",\"targetType\":\"agent\",\"targetId\":\"$AGENT_ID\"}" || true

# Stream via a fifo (not a pipe) so we can kill curl the instant a real event
# lands. A plain `curl | awk 'exit'` leaves curl alive until its next write
# (the 25s heartbeat or --max-time), and the shell blocks on the whole pipeline
# — so the caller wouldn't wake until then. Reading from a fifo lets us break
# and kill curl immediately.
fifo="$(mktemp -u)"
mkfifo "$fifo"
curl -sN --max-time "$MAX_SECONDS" -H "Authorization: Bearer $TOKEN" "$API_URL/events" > "$fifo" &
curl_pid=$!

while IFS= read -r line; do
  case "$line" in
    "data: "*) printf '%s\n' "${line#data: }"; break ;;   # the full AppEvent JSON
  esac
done < "$fifo"

kill "$curl_pid" 2>/dev/null || true
rm -f "$fifo"
