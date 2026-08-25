#!/usr/bin/env bash
# Relai background event watcher — wake-loop wrapper around relai-stream-wait.sh.
#
# Resolves the agent's API URL / token / id from env or the repo's .mcp.json,
# self-subscribes, then blocks on the SSE stream. It reconnects across
# heartbeats, timeouts, and drops, so it exits ONLY when a genuine relai event
# arrives (a task assigned to you, a message). Designed to be launched from an
# interactive agent via Bash run_in_background:true: the agent keeps working at
# zero model cost and is re-invoked the moment an event lands.
#
# Usage: relai-watch.sh [--repo-path <dir> | <dir>]
#
# Config is auto-resolved from the target repo's .mcp.json, so no args are
# needed WHEN launched from inside that repo. But do NOT rely on the caller's
# working directory: an agent that relaunches this watcher in a separate
# background Bash call gets a fresh shell whose $PWD is reset to the session
# root, not the repo — so $PWD/.mcp.json silently misses and the watcher exits
# with "could not resolve API_SECRET / AGENT_ID" even though creds exist right
# there in the repo. To be robust the watcher searches several locations (see
# below); pass --repo-path (or the repo dir as the first arg) to pin it
# explicitly and skip the guessing.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Optional explicit repo root: --repo-path <dir> or a bare first positional arg.
repo_path=""
case "${1:-}" in
  --repo-path)
    repo_path="${2:-}"
    ;;
  --repo-path=*)
    repo_path="${1#--repo-path=}"
    ;;
  -*)
    ;;
  ?*)
    repo_path="$1"
    ;;
esac

API_URL="${API_URL:-}"
API_SECRET="${API_SECRET:-}"
AGENT_ID="${AGENT_ID:-}"

# Fall back to the repo's .mcp.json relai server env when not already in the
# environment. Keeps the token out of the agent's launch command (and context).
#
# Resolve the .mcp.json from the first candidate that exists, in priority order,
# rather than trusting a single $PWD/$CLAUDE_PROJECT_DIR guess that a fresh
# background shell may have reset:
#   1. --repo-path / first-arg (explicit; wins)
#   2. $CLAUDE_PROJECT_DIR (set by Claude Code)
#   3. `git rev-parse --show-toplevel` from $PWD (the actual enclosing repo)
#   4. $PWD, then each parent directory walking upward to /
if [ -z "$API_SECRET" ] || [ -z "$AGENT_ID" ] || [ -z "$API_URL" ]; then
  candidates=()
  [ -n "$repo_path" ] && candidates+=("$repo_path")
  [ -n "${CLAUDE_PROJECT_DIR:-}" ] && candidates+=("$CLAUDE_PROJECT_DIR")
  if command -v git >/dev/null 2>&1; then
    git_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    [ -n "$git_root" ] && candidates+=("$git_root")
  fi
  dir="$PWD"
  while :; do
    candidates+=("$dir")
    [ "$dir" = "/" ] && break
    dir="$(dirname "$dir")"
  done

  mcp_json=""
  for c in "${candidates[@]}"; do
    if [ -f "$c/.mcp.json" ]; then
      mcp_json="$c/.mcp.json"
      break
    fi
  done

  if [ -n "$mcp_json" ] && command -v node >/dev/null 2>&1; then
    eval "$(node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const e = (((j.mcpServers || {}).relai || {}).env) || {};
        const q = (k, v) => (v ? `${k}=${JSON.stringify(String(v))}` : "");
        console.log([q("API_URL", e.API_URL), q("API_SECRET", e.API_SECRET), q("AGENT_ID", e.AGENT_ID)].filter(Boolean).join("\n"));
      } catch (_) { /* unreadable .mcp.json — leave vars unset */ }
    ' "$mcp_json")"
  fi
fi

API_URL="${API_URL:-http://localhost:3010}"

if [ -z "${API_SECRET:-}" ] || [ -z "${AGENT_ID:-}" ]; then
  echo "relai-watch: could not resolve API_SECRET / AGENT_ID." >&2
  echo "  Searched .mcp.json in --repo-path, \$CLAUDE_PROJECT_DIR, the enclosing git repo, and \$PWD upward." >&2
  echo "  Pass the repo dir explicitly (relai-watch.sh --repo-path /path/to/repo) or set the vars in env." >&2
  exit 1
fi

# Tracking, so a watcher that dies is distinguishable from one with nothing to
# say. Logs to a FILE, never stdout: stdout is the event handed back to the caller.
RELAI_WATCH_LOG="${RELAI_WATCH_LOG:-$HOME/Library/Logs/relai/watcher.log}"
RELAI_WATCH_RUN="${RELAI_WATCH_RUN:-$$-$(date +%s)}"
export RELAI_WATCH_LOG RELAI_WATCH_RUN
WATCH_STARTED=$(date +%s)
mkdir -p "$(dirname "$RELAI_WATCH_LOG")" 2>/dev/null || true
wlog() {
  printf '%s run=%s pid=%s ppid=%s agent=%s up=%s %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RELAI_WATCH_RUN" "$$" "$PPID" "$AGENT_ID" \
    "$(( $(date +%s) - WATCH_STARTED ))" "$*" >> "$RELAI_WATCH_LOG" 2>/dev/null || true
}
# up= at death is the whole point: a consistent value across kills means an
# external timer, a scattered one means something in here.
child=""
on_signal() {
  wlog "watcher-exit reason=signal sig=$1 child=${child:-none}"
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
  exit 130
}
trap 'on_signal TERM' TERM
trap 'on_signal INT'  INT
trap 'on_signal HUP'  HUP

window="${RELAI_WATCH_WINDOW:-590}"   # per-connection cap before a silent reconnect
backoff="${RELAI_WATCH_BACKOFF:-2}"   # pause after a timeout/drop before reconnecting

# Loop until a real event prints something; timeouts and drops just reconnect,
# so the model is never woken by a heartbeat or an idle window.
wlog "watcher-start api=$API_URL window=${window}s backoff=${backoff}s"

windows=0
outfile="$(mktemp)"
trap 'rm -f "$outfile"' EXIT
while true; do
  # Backgrounded + `wait` rather than $(...): a foreground child makes the signal
  # traps above undeliverable until it finishes, which is how kills orphaned curl.
  : > "$outfile"
  RELAI_TOKEN="$API_SECRET" "$here/relai-stream-wait.sh" "$API_URL" "$AGENT_ID" "$window" >"$outfile" 2>/dev/null &
  child=$!
  wait "$child"; rc=$?
  child=""
  out="$(cat "$outfile")"
  windows=$((windows + 1))
  if [ -n "$out" ]; then
    wlog "watcher-exit reason=event windows=$windows"
    printf '%s\n' "$out"
    exit 0
  fi
  wlog "window-reconnect n=$windows rc=$rc"
  sleep "$backoff"
done
