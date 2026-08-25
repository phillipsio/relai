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
# Usage: RELAI_TOKEN=<token> relai-stream-wait.sh <api_url> <agent_id> [max_seconds]
#
# The token comes from the environment, never argv: `ps` exposes process
# arguments, so passing it positionally published every agent's bearer token.
set -uo pipefail

API_URL="$1"
AGENT_ID="$2"
MAX_SECONDS="${3:-590}"
TOKEN="${RELAI_TOKEN:?RELAI_TOKEN must be set — the token is read from the environment, not argv}"

# Catch the pre-2026-08-25 positional form, which would read the token as the agent id.
case "$AGENT_ID" in
  aio_*)
    echo "relai-stream-wait.sh: arg 2 looks like a token. Signature is now <api_url> <agent_id> with RELAI_TOKEN in env." >&2
    exit 2
    ;;
esac

# Lifecycle logging goes to a FILE, never stdout: the caller treats any stdout
# from this script as the event that ends its wait.
LOG="${RELAI_WATCH_LOG:-$HOME/Library/Logs/relai/watcher.log}"
RUN="${RELAI_WATCH_RUN:-unknown}"
STARTED=$(date +%s)
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
wlog() {
  printf '%s run=%s pid=%s ppid=%s agent=%s up=%s %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN" "$$" "$PPID" "$AGENT_ID" \
    "$(( $(date +%s) - STARTED ))" "$*" >> "$LOG" 2>/dev/null || true
}

# No trap meant a killed window leaked its fifo AND orphaned its curl, which kept
# an SSE connection open and writing for up to --max-time after the script died.
cleanup() {
  [ -n "${curl_pid:-}" ] && kill "$curl_pid" 2>/dev/null
  [ -n "${fifo:-}" ] && rm -f "$fifo"
}
on_signal() { wlog "window-end reason=signal sig=$1"; cleanup; exit 130; }
trap 'on_signal TERM' TERM
trap 'on_signal INT'  INT
trap 'on_signal HUP'  HUP
trap cleanup EXIT

wlog "window-start max=${MAX_SECONDS}s"

# -K from a process substitution: curl's own -H would put the token back into ps.
authcfg() { printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"; }

curl -sS -o /dev/null -K <(authcfg) \
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
curl -sN --max-time "$MAX_SECONDS" -K <(authcfg) "$API_URL/events" > "$fifo" &
curl_pid=$!

while IFS= read -r line; do
  case "$line" in
    "data: "*) got_event=1; printf '%s\n' "${line#data: }"; break ;;   # the full AppEvent JSON
  esac
done < "$fifo"

if [ -n "${got_event:-}" ]; then
  wlog "window-end reason=event"
else
  wlog "window-end reason=timeout"
fi
cleanup
