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
# Usage: relai-watch.sh        (config auto-resolved; no args needed)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

API_URL="${API_URL:-}"
API_SECRET="${API_SECRET:-}"
AGENT_ID="${AGENT_ID:-}"

# Fall back to the repo's .mcp.json relai server env when not already in the
# environment. Keeps the token out of the agent's launch command (and context).
if [ -z "$API_SECRET" ] || [ -z "$AGENT_ID" ] || [ -z "$API_URL" ]; then
  mcp_json="${CLAUDE_PROJECT_DIR:-$PWD}/.mcp.json"
  if [ -f "$mcp_json" ] && command -v node >/dev/null 2>&1; then
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
  echo "relai-watch: could not resolve API_SECRET / AGENT_ID (set them in env or the relai server block of .mcp.json)" >&2
  exit 1
fi

window="${RELAI_WATCH_WINDOW:-590}"   # per-connection cap before a silent reconnect
backoff="${RELAI_WATCH_BACKOFF:-2}"   # pause after a timeout/drop before reconnecting

# Loop until a real event prints something; timeouts and drops just reconnect,
# so the model is never woken by a heartbeat or an idle window.
while true; do
  out="$("$here/relai-stream-wait.sh" "$API_URL" "$API_SECRET" "$AGENT_ID" "$window" 2>/dev/null)" || true
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
    exit 0
  fi
  sleep "$backoff"
done
