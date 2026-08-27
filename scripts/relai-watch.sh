#!/usr/bin/env bash
# Relai background event watcher — wake-loop wrapper around relai-stream-wait.sh.
#
# Resolves the agent's API URL / token / id from env or the repo's .mcp.json,
# self-subscribes, then blocks on the SSE stream. It reconnects across
# heartbeats, timeouts, and drops, so it never ends on its own for anything less
# than a genuine relai event (a task assigned to you, a message). It can still be
# ended from outside: Claude Code reaps background tasks on a recurring timer, and
# that exit carries no event. Distinguish the two by the output, not the exit:
# an event prints JSON on stdout, a kill prints nothing.
# Designed to be launched from an interactive agent via Bash run_in_background:true:
# the agent keeps working at zero model cost and is re-invoked when the task ends.
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
#   4. $PWD walking upward to the git root (or just $PWD if not in a repo)
if [ -z "$API_SECRET" ] || [ -z "$AGENT_ID" ] || [ -z "$API_URL" ]; then
  candidates=()
  [ -n "$repo_path" ] && candidates+=("$repo_path")
  [ -n "${CLAUDE_PROJECT_DIR:-}" ] && candidates+=("$CLAUDE_PROJECT_DIR")
  if command -v git >/dev/null 2>&1; then
    git_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    [ -n "$git_root" ] && candidates+=("$git_root")
  fi
  # Bounded at the enclosing repo: walking to / let any parent, including /
  # and /tmp, supply credentials to a session started anywhere beneath it.
  # `pwd -P` resolves symlinks — `git rev-parse --show-toplevel` already
  # returns a physical path, and comparing a logical $PWD against it let the
  # walk reach / on any machine where a path component is a symlink (macOS
  # /tmp -> /private/tmp, so any session under /tmp walked unbounded).
  # With no git root the walk is deliberately just $PWD itself, not a climb
  # to / — nothing bounds that climb when there's no repo root to stop at.
  dir="$(cd "$PWD" 2>/dev/null && pwd -P || printf '%s' "$PWD")"
  if [ -n "${git_root:-}" ]; then
    while :; do
      candidates+=("$dir")
      [ "$dir" = "$git_root" ] && break
      [ "$dir" = "/" ] && break
      dir="$(dirname "$dir")"
    done
  else
    candidates+=("$dir")
  fi

  mcp_json=""
  for c in "${candidates[@]}"; do
    if [ -f "$c/.mcp.json" ]; then
      mcp_json="$c/.mcp.json"
      break
    fi
  done

  if [ -n "$mcp_json" ] && command -v node >/dev/null 2>&1; then
    # NUL-delimited pairs read into the shell, never eval: a .mcp.json value is
    # untrusted input and $(...) or `...` in one would otherwise execute.
    while IFS= read -r -d "" kv; do
      case "$kv" in
        API_URL=*)    [ -z "$API_URL" ]    && API_URL="${kv#API_URL=}" ;;
        API_SECRET=*) [ -z "$API_SECRET" ] && API_SECRET="${kv#API_SECRET=}" ;;
        AGENT_ID=*)   [ -z "$AGENT_ID" ]   && AGENT_ID="${kv#AGENT_ID=}" ;;
      esac
    done < <(node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const e = (((j.mcpServers || {}).relai || {}).env) || {};
        let out = "";
        for (const k of ["API_URL", "API_SECRET", "AGENT_ID"]) {
          if (e[k]) out += k + "=" + String(e[k]) + "\0";
        }
        process.stdout.write(out);
      } catch (_) { /* unreadable .mcp.json — leave vars unset */ }
    ' "$mcp_json")
  fi
fi

API_URL="${API_URL:-http://localhost:3010}"

case "$API_URL" in
  http://*|https://*) ;;
  *) echo "relai-watch: refusing a non-http(s) API_URL from config: $API_URL" >&2; exit 1 ;;
esac

# A control character (newline in particular) in any of these reaches curl's
# -K config file downstream (relai-stream-wait.sh) and injects config-file
# directives — a value like "tok\noutput = /some/path" redirects curl's
# response to an attacker-chosen file. Reject before it ever gets there.
for _n in API_URL API_SECRET AGENT_ID; do
  eval "_v=\${$_n:-}"
  case "$_v" in
    *[![:print:]]*)
      echo "relai-watch: $_n from config contains a control character — refusing" >&2
      exit 1
      ;;
  esac
done
unset _n _v

# `agent_*` alone only checks the PREFIX — a value like agent_x","targetType
# still matches it, since `*` matches any remaining characters including
# quotes. Reject anything outside the id's real charset too.
case "$AGENT_ID" in
  "") ;;
  agent_*)
    case "$AGENT_ID" in
      *[![:alnum:]_-]*) echo "relai-watch: AGENT_ID '$AGENT_ID' contains a character outside [A-Za-z0-9_-] — refusing" >&2; exit 1 ;;
    esac
    ;;
  *) echo "relai-watch: AGENT_ID '$AGENT_ID' doesn't look like an agent id (expected agent_*)" >&2; exit 1 ;;
esac

if [ -z "${API_SECRET:-}" ] || [ -z "${AGENT_ID:-}" ]; then
  echo "relai-watch: could not resolve API_SECRET / AGENT_ID." >&2
  echo "  Searched .mcp.json in --repo-path, \$CLAUDE_PROJECT_DIR, and \$PWD up to the enclosing git root." >&2
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

# At most one live watcher per agent. Not derived from RELAI_WATCH_LOG's
# directory — that breaks when the log is silenced to /dev/null.
pidfile_dir="${RELAI_WATCH_PIDFILE_DIR:-$HOME/.relai}"
mkdir -p "$pidfile_dir" 2>/dev/null || true
pidfile="$pidfile_dir/watch-$AGENT_ID.pid"
lockdir="$pidfile.lock"

# A bare pid survives a reboot and pids get reused — only ever act on an
# entry confirmed to still be a relai-watch.sh process, not just any process.
is_our_watcher() {
  kill -0 "$1" 2>/dev/null && ps -p "$1" -o command= 2>/dev/null | grep -q 'relai-watch\.sh'
}

# mkdir is atomic across processes: without a lock, two racing instances
# could both replace the incumbent and both write, leaking the loser.
lock_acquired=0
for _ in $(seq 1 100); do
  mkdir "$lockdir" 2>/dev/null && { lock_acquired=1; break; }
  sleep 0.1
done
if [ "$lock_acquired" -ne 1 ]; then
  wlog "watcher-exit reason=lock-timeout"
  echo "relai-watch: could not acquire the startup lock for $AGENT_ID (rmdir \"$lockdir\" if no relai-watch.sh is actually running)" >&2
  exit 1
fi

if [ -s "$pidfile" ]; then
  old_pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$old_pid" ] && is_our_watcher "$old_pid"; then
    wlog "watcher-start replacing pid=$old_pid"
    kill -TERM "$old_pid" 2>/dev/null
    for _ in $(seq 1 50); do
      is_our_watcher "$old_pid" || break
      sleep 0.1
    done
    if is_our_watcher "$old_pid"; then
      wlog "watcher-start kill-escalate pid=$old_pid"
      kill -KILL "$old_pid" 2>/dev/null
      for _ in $(seq 1 20); do
        is_our_watcher "$old_pid" || break
        sleep 0.1
      done
    fi
    # Refusing to start beats proceeding and creating an untracked duplicate.
    if is_our_watcher "$old_pid"; then
      rmdir "$lockdir" 2>/dev/null
      wlog "watcher-exit reason=replace-failed pid=$old_pid"
      echo "relai-watch: could not replace the running watcher (pid $old_pid) for $AGENT_ID — refusing to start a second one" >&2
      exit 1
    fi
  fi
fi
if ! echo "$$" > "$pidfile"; then
  wlog "pidfile-write-failed dir=$pidfile_dir"
  echo "relai-watch: cannot write $pidfile — running without single-instance protection" >&2
fi
rmdir "$lockdir" 2>/dev/null

window="${RELAI_WATCH_WINDOW:-590}"   # per-connection cap before a silent reconnect
backoff="${RELAI_WATCH_BACKOFF:-2}"   # pause after a timeout/drop before reconnecting

# Loop until a real event prints something; timeouts and drops just reconnect,
# so the model is never woken by a heartbeat or an idle window.
wlog "watcher-start api=$API_URL window=${window}s backoff=${backoff}s"

windows=0
setup_failures=0
outfile="$(mktemp)"
# Remove the pidfile only if it still names us — a race where a newer instance
# already replaced us must not delete that instance's own entry.
trap 'rm -f "$outfile"; [ "$(cat "$pidfile" 2>/dev/null)" = "$$" ] && rm -f "$pidfile"' EXIT
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
  # rc=3 means setup failed (bad TMPDIR, mkfifo denied) rather than a normal
  # timeout/drop — that doesn't clear on its own, so retrying at the normal
  # 2s backoff is a hot loop. Back off hard and give up after repeated failure
  # rather than hammering the API (or the filesystem) forever.
  if [ "$rc" -eq 3 ]; then
    setup_failures=$((setup_failures + 1))
    if [ "$setup_failures" -ge 5 ]; then
      wlog "watcher-exit reason=setup-failure-exhausted count=$setup_failures"
      echo "relai-watch: giving up after $setup_failures consecutive setup failures — check TMPDIR / permissions" >&2
      exit 1
    fi
    wlog "window-reconnect n=$windows rc=$rc setup_failures=$setup_failures backoff=60s"
    sleep 60 & wait $!   # backgrounded: a foreground sleep defers a trapped signal until it returns
    continue
  fi
  setup_failures=0
  wlog "window-reconnect n=$windows rc=$rc"
  sleep "$backoff" & wait $!
done
