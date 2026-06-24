#!/usr/bin/env bash
# Block on relai's SSE event stream until a real event arrives (or timeout),
# then print it and exit. The API sends a ": ping" comment every 25s to keep
# the connection alive — those are filtered out, only a real `data:` line ends
# the wait. Costs nothing while blocked: this is a tool call, not a model turn.
#
# Self-subscribes to the agent's own agent-target first: task-assignment events
# fan out via that target (alsoNotify), but agents aren't auto-subscribed to
# themselves, so without this the stream never delivers new tasks assigned to
# us — the exact events this is meant to catch. The route is idempotent.
#
# Usage: relai-stream-wait.sh <api_url> <token> <agent_id> [max_seconds]
set -euo pipefail

API_URL="$1"
TOKEN="$2"
AGENT_ID="$3"
MAX_SECONDS="${4:-590}"

curl -sS -o /dev/null \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$API_URL/subscriptions" \
  -d "{\"agentId\":\"$AGENT_ID\",\"targetType\":\"agent\",\"targetId\":\"$AGENT_ID\"}"

curl -sN --max-time "$MAX_SECONDS" \
  -H "Authorization: Bearer $TOKEN" \
  "$API_URL/events" \
  | awk '/^data: /{print; exit} /^: /{next}'
