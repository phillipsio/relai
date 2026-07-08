#!/bin/bash
# relai-livez-watch.sh — external watchdog for the self-hosted relai API.
#
# Polls the unauthenticated /livez readiness probe. On a healthy→unhealthy
# transition it fires a macOS notification and logs it; on recovery it does the
# same the other way. Transition-gated so a long outage doesn't notify every run.
#
# Meant to be run on a schedule (launchd StartInterval / cron). Independent of
# the API process so it can alert precisely when the API/DB is unreachable —
# the exact case in-app notification channels cannot cover.
#
# Env overrides: RELAI_LIVEZ_URL (default http://localhost:3010/livez).

URL="${RELAI_LIVEZ_URL:-http://localhost:3010/livez}"
STATE_FILE="${TMPDIR:-/tmp}/relai-livez-state"
LOG_DIR="$HOME/Library/Logs/relai"
LOG_FILE="$LOG_DIR/watchdog.log"
mkdir -p "$LOG_DIR"

if curl -sf --max-time 5 "$URL" >/dev/null 2>&1; then
  now="up"
else
  now="down"
fi

prev="unknown"
[ -f "$STATE_FILE" ] && prev="$(cat "$STATE_FILE" 2>/dev/null)"
printf '%s' "$now" > "$STATE_FILE"

# Only act on a state transition (or the first run if it comes up down).
if [ "$now" = "$prev" ]; then
  exit 0
fi

ts="$(date '+%Y-%m-%d %H:%M:%S')"
if [ "$now" = "down" ]; then
  printf '%s  DOWN — %s unreachable\n' "$ts" "$URL" >> "$LOG_FILE"
  osascript -e 'display notification "relai API/DB is unreachable" with title "relai watchdog" sound name "Basso"' >/dev/null 2>&1
elif [ "$prev" != "unknown" ]; then
  # Recovery — only announce if we had previously reported down.
  printf '%s  RECOVERED — %s ok\n' "$ts" "$URL" >> "$LOG_FILE"
  osascript -e 'display notification "relai API recovered" with title "relai watchdog"' >/dev/null 2>&1
fi
