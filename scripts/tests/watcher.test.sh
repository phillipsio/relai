#!/usr/bin/env bash
# Covers the watcher/stream-wait scripts: argument validation, signal traps,
# credential-resolution safety, and that a kill leaves no fifo or curl behind.
# Uses a fake SSE server, so it needs no relai API and no credentials.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
pass=0; fail=0

# Every relai-watch.sh invocation in this file goes through this pidfile dir,
# not the real default (~/.relai) — set globally, once, so no block (old or
# new) can ever read or replace a real running watcher's entry.
PIDFILE_SCRATCH="$(mktemp -d)"
export RELAI_WATCH_PIDFILE_DIR="$PIDFILE_SCRATCH"

trap 'kill "${SRV_PID:-}" 2>/dev/null; [ -n "${SCRATCH:-}" ] && rm -rf "$SCRATCH"; rm -rf "$PIDFILE_SCRATCH"' EXIT INT TERM

ok()   { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

start_server() {
  local emit="${1:--1}" ping="${2:-0.25}" out
  out="$(mktemp)"
  python3 "$HERE/fake-sse-server.py" "$emit" "$ping" >"$out" 2>/dev/null &
  SRV_PID=$!
  for _ in $(seq 1 40); do
    PORT="$(head -1 "$out" 2>/dev/null)"
    [ -n "${PORT:-}" ] && break
    sleep 0.1
  done
  rm -f "$out"
  [ -n "${PORT:-}" ] || { bad "fake server never reported a port"; return 1; }
}
stop_server() { kill "${SRV_PID:-}" 2>/dev/null; wait "${SRV_PID:-}" 2>/dev/null; }

fifos() { find "${SCRATCH:-${TMPDIR:-/tmp}}" -type p 2>/dev/null | wc -l | tr -d ' '; }

# Poll rather than sleep: cleanup is asynchronous in the grandchild, so a fixed
# wait is a race that passes or fails on machine load.
poll_until() {
  local want="$1" fn="$2" i
  for i in $(seq 1 60); do
    [ "$($fn)" = "$want" ] && return 0
    sleep 0.1
  done
  return 1
}
curls() { pgrep -f 'curl .*'"${PORT:-__none__}"'/events' 2>/dev/null | wc -l | tr -d ' '; }
# ps -eo on macOS/BSD means "also show environment", not just "every process" —
# an exported var can then match here even though it's not in argv. -Ao does
# not dump environment on either BSD or GNU ps, so it actually checks argv.
argv_has() { ps -Ao command= | grep -v '[g]rep' | grep -c -- "$1" || true; }

# --- argument validation: no network needed -----------------------------------

RELAI_TOKEN=t bash "$SCRIPTS/relai-stream-wait.sh" http://127.0.0.1:1 aio_looksLikeAToken 1 >/dev/null 2>&1
check "old positional token form is rejected, not silently misread" "$?" "2"

out="$(bash "$SCRIPTS/relai-stream-wait.sh" http://127.0.0.1:1 agent_x 1 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "missing RELAI_TOKEN fails closed" || bad "missing RELAI_TOKEN exited 0"
case "$out" in *RELAI_TOKEN*) ok "…and says which variable is missing";; *) bad "error text does not name RELAI_TOKEN";; esac

out="$(RELAI_TOKEN=t bash "$SCRIPTS/relai-stream-wait.sh" http://127.0.0.1:1 not-an-agent-id 1 2>&1)"
[ "$?" -ne 0 ] && ok "AGENT_ID not shaped like agent_* is rejected" || bad "malformed AGENT_ID exited 0"

out="$(printf 'x' | RELAI_TOKEN="$(printf 'tok\nmalicious')" bash "$SCRIPTS/relai-stream-wait.sh" http://127.0.0.1:1 agent_x 1 2>&1)"
[ "$?" -ne 0 ] && ok "a token containing a newline is rejected before reaching curl" \
  || bad "newline-bearing token was accepted"

# --- the event path -----------------------------------------------------------

if start_server 1; then
  got="$(RELAI_TOKEN=t RELAI_WATCH_LOG=/dev/null bash "$SCRIPTS/relai-stream-wait.sh" "http://127.0.0.1:$PORT" agent_x 10 2>/dev/null)"
  case "$got" in *evt_test*) ok "a real data: line is printed and ends the wait";; *) bad "event not returned (got '${got:0:60}')";; esac
  stop_server
fi

if start_server -1; then
  got="$(RELAI_TOKEN=t RELAI_WATCH_LOG=/dev/null bash "$SCRIPTS/relai-stream-wait.sh" "http://127.0.0.1:$PORT" agent_x 1 2>/dev/null)"
  check "pings alone produce no output (nothing to wake on)" "${got:-empty}" "empty"
  stop_server
fi

# --- signals: the case that used to orphan curl and leak a fifo ---------------

# 25s pings, matching the real API: with a tighter interval an orphaned curl
# takes SIGPIPE on its own and the leak assertions pass without any cleanup.
SCRATCH="$(mktemp -d)"
if start_server -1 25; then
  LOG="$(mktemp)"; before_f="$(fifos)"; before_c="$(curls)"
  RELAI_FIFO_DIR="$SCRATCH" RELAI_WATCH_LOG="$LOG" RELAI_WATCH_WINDOW=30 RELAI_WATCH_BACKOFF=1 \
    API_URL="http://127.0.0.1:$PORT" API_SECRET=t AGENT_ID=agent_x \
    bash "$SCRIPTS/relai-watch.sh" >/dev/null 2>&1 &
  wpid=$!
  # A leak assertion that never confirms the thing it's checking for existed is
  # vacuous — it would pass identically if the window never opened at all.
  if poll_until 1 fifos; then
    kill -TERM "$wpid" 2>/dev/null
    poll_until "$before_f" fifos; fifo_ok=$?
    poll_until "$before_c" curls; curl_ok=$?

    grep -q 'watcher-exit reason=signal sig=TERM' "$LOG" \
      && ok "TERM mid-window logs watcher-exit (trap is deliverable)" \
      || bad "no watcher-exit line — trap did not fire mid-window"
    grep -q 'window-end reason=signal' "$LOG" \
      && ok "…and the signal reaches the child window" \
      || bad "child window logged no signal — TERM was not propagated"
    grep -q 'watcher-start' "$LOG" && ok "lifecycle start is recorded" || bad "no watcher-start line"

    [ "$fifo_ok" -eq 0 ] && ok "no fifo leaked across the kill" \
      || bad "fifo leaked across the kill (expected $before_f, got $(fifos))"
    [ "$curl_ok" -eq 0 ] && ok "no curl orphaned across the kill" \
      || bad "curl orphaned across the kill (expected $before_c, got $(curls))"
  else
    bad "window never opened — leak assertions below would be vacuous, skipped"
    kill -TERM "$wpid" 2>/dev/null
  fi
  rm -f "$LOG"; stop_server
fi
rm -rf "$SCRATCH"; SCRATCH=""

# --- the token must not reach any process listing -----------------------------
# This is the bug that shipped once: moving it out of this script's argv left
# curl's own -H putting it straight back into ps.

# Positive control first: prove argv_has() can actually see something that IS
# in argv, so a later "not found" isn't just the check being blind.
yes MARKER_CONTROL_VISIBLE >/dev/null 2>&1 &
ctrlpid=$!
sleep 0.3
[ "$(argv_has MARKER_CONTROL_VISIBLE)" -gt 0 ] \
  && ok "argv check can see a real argv value (control is meaningful)" \
  || bad "argv_has() saw nothing for a value known to be in argv — check is broken"
kill "$ctrlpid" 2>/dev/null; wait "$ctrlpid" 2>/dev/null

if start_server -1; then
  FAKE="ThisIsAFakeTestTokenNotARealCredential"

  # The long-lived SSE stream call.
  RELAI_TOKEN="$FAKE" RELAI_WATCH_LOG=/dev/null \
    bash "$SCRIPTS/relai-stream-wait.sh" "http://127.0.0.1:$PORT" agent_x 5 >/dev/null 2>&1 &
  swpid=$!
  poll_until 1 curls
  if [ "$(argv_has "$FAKE")" -gt 0 ]; then
    bad "token appears in the process table during the stream call"
  else
    ok "token appears in no process argv during the stream call"
  fi
  kill -TERM "$swpid" 2>/dev/null; wait "$swpid" 2>/dev/null

  # The short-lived subscription POST — checked separately because it completes
  # in well under a second, so a single ps snapshot after the stream call starts
  # would never see it: a mutant reverting only this call to -H would slip past
  # a test that only checked the stream call.
  RELAI_TOKEN="$FAKE" RELAI_WATCH_LOG=/dev/null \
    bash "$SCRIPTS/relai-stream-wait.sh" "http://127.0.0.1:$PORT" agent_x 1 >/dev/null 2>&1 &
  subpid=$!
  hits=0; for _ in $(seq 1 30); do
    h="$(argv_has "$FAKE")"
    [ "$h" -gt 0 ] && hits=$h
    kill -0 "$subpid" 2>/dev/null || break
  done
  [ "$hits" -eq 0 ] && ok "token appears in no process argv during the subscription POST" \
    || bad "token appeared in argv during the subscription POST ($hits hit(s))"
  wait "$subpid" 2>/dev/null
  stop_server
fi

# --- .mcp.json parsing: the eval-removal this whole commit is about -----------
# The NUL-delimited reader replaced `eval "$(node -e ...)"`. Nothing above
# exercises it at all: every prior call sets API_URL/API_SECRET/AGENT_ID via
# env, which skips the .mcp.json-discovery branch entirely.

mcpdir="$(mktemp -d)"
cat >"$mcpdir/.mcp.json" <<JSON
{"mcpServers":{"relai":{"env":{
  "API_URL":"http://127.0.0.1:1",
  "AGENT_ID":"agent_x",
  "API_SECRET":"tok\$(touch $mcpdir/PWNED_SUBSHELL)\`touch $mcpdir/PWNED_BACKTICK\`"
}}}}
JSON
API_URL= API_SECRET= AGENT_ID= bash "$SCRIPTS/relai-watch.sh" --repo-path "$mcpdir" >/dev/null 2>&1 &
mpid=$!
sleep 1
kill -TERM "$mpid" 2>/dev/null; wait "$mpid" 2>/dev/null
if [ -e "$mcpdir/PWNED_SUBSHELL" ] || [ -e "$mcpdir/PWNED_BACKTICK" ]; then
  bad ".mcp.json value with \$(...) / \`...\` was executed"
else
  ok ".mcp.json value with \$(...) / \`...\` is read as inert data, not executed"
fi
rm -rf "$mcpdir"

# relai-watch.sh validates AGENT_ID itself (not just relai-stream-wait.sh's
# copy of the check) before ever spawning it — an embedded quote is also the
# shape that would break out of the JSON body relai-stream-wait.sh builds.
mcpdir="$(mktemp -d)"
cat >"$mcpdir/.mcp.json" <<'JSON'
{"mcpServers":{"relai":{"env":{"API_URL":"http://127.0.0.1:1","AGENT_ID":"agent_x\",\"targetType\":\"thread","API_SECRET":"t"}}}}
JSON
badout="$(mktemp)"
( API_URL= API_SECRET= AGENT_ID= bash "$SCRIPTS/relai-watch.sh" --repo-path "$mcpdir" >"$badout" 2>&1 ) &
bpid=$!
sleep 1
kill -TERM "$bpid" 2>/dev/null; wait "$bpid" 2>/dev/null
out="$(cat "$badout")"; rm -f "$badout"
case "$out" in
  *"doesn't look like an agent id"*|*"outside [A-Za-z0-9_-]"*) ok "relai-watch.sh itself rejects a malformed AGENT_ID from .mcp.json" ;;
  *) bad "malformed AGENT_ID from .mcp.json was not rejected by relai-watch.sh (out='${out:0:100}')" ;;
esac
rm -rf "$mcpdir"

# A newline in a .mcp.json value reaches curl's -K config file downstream and
# can inject config directives (e.g. redirect the response to an attacker
# path) — a different vulnerability class than shell injection, closed by
# validating the parsed value rather than by how it's read.
mcpdir="$(mktemp -d)"
node -e '
  const fs = require("fs");
  const payload = "tok\"\noutput = " + process.argv[1] + "/PWNED_CURL_K\nurl = http://127.0.0.1:1/x\n#";
  fs.writeFileSync(process.argv[1] + "/.mcp.json", JSON.stringify({
    mcpServers: { relai: { env: { API_URL: "http://127.0.0.1:1", AGENT_ID: "agent_x", API_SECRET: payload } } }
  }));
' "$mcpdir"
API_URL= API_SECRET= AGENT_ID= bash "$SCRIPTS/relai-watch.sh" --repo-path "$mcpdir" >/dev/null 2>&1 &
mpid=$!
sleep 1
kill -TERM "$mpid" 2>/dev/null; wait "$mpid" 2>/dev/null
if [ -e "$mcpdir/PWNED_CURL_K" ]; then
  bad "a newline in a .mcp.json value reached curl's -K config file"
else
  ok "a newline in a .mcp.json value is rejected before reaching curl"
fi
rm -rf "$mcpdir"

# --- the git-root walk bound: both the positive and negative case -------------

walkdir="$(mktemp -d)"
mkdir -p "$walkdir/outer/repo/sub"
# Decoy one level ABOVE the repo root — must never be picked up.
cat >"$walkdir/outer/.mcp.json" <<'JSON'
{"mcpServers":{"relai":{"env":{"API_URL":"http://127.0.0.1:1","AGENT_ID":"agent_decoy","API_SECRET":"decoy"}}}}
JSON
( cd "$walkdir/outer/repo" && git init -q && git config user.email t@t && git config user.name t \
  && git commit -q --allow-empty -m init )
# Backgrounded + killed rather than awaited: if the walk bound is broken and
# the decoy IS picked up, its (unreachable) API_URL still parses as valid, so
# relai-watch.sh enters its normal reconnect-forever loop instead of exiting
# — a synchronous call here would hang the whole suite on a regression.
decout="$(mktemp)"
( cd "$walkdir/outer/repo/sub" && API_URL= API_SECRET= AGENT_ID= RELAI_WATCH_LOG=/dev/null \
    bash "$SCRIPTS/relai-watch.sh" >"$decout" 2>&1 ) &
dpid=$!
sleep 1
kill -TERM "$dpid" 2>/dev/null; wait "$dpid" 2>/dev/null
out="$(cat "$decout")"; rm -f "$decout"
# A picked-up decoy produces no stdout at all: it enters the normal silent
# reconnect loop, not an error message. So the ONLY passing signature is the
# explicit "could not resolve" text — empty output means the walk succeeded
# in resolving (wrong) credentials and must fail this check, not be treated
# as ambiguous.
case "$out" in
  *"could not resolve"*) ok "a .mcp.json above the git root is NOT picked up (walk stops at git root)" ;;
  *) bad "a .mcp.json above the git root was picked up (no rejection message; out='${out:0:100}')" ;;
esac
rm -rf "$walkdir"

# Positive case: a .mcp.json AT the git root is still found (the walk isn't
# just refusing everything). Target address doesn't need to be reachable —
# only whether the credentials were discovered at all is under test here.
walkdir="$(mktemp -d)"
mkdir -p "$walkdir/repo/sub"
cat >"$walkdir/repo/.mcp.json" <<'JSON'
{"mcpServers":{"relai":{"env":{"API_URL":"http://127.0.0.1:1","AGENT_ID":"agent_atroot","API_SECRET":"t"}}}}
JSON
( cd "$walkdir/repo" && git init -q && git config user.email t@t && git config user.name t \
  && git commit -q --allow-empty -m init )
posout="$(mktemp)"
( cd "$walkdir/repo/sub" && API_URL= API_SECRET= AGENT_ID= RELAI_WATCH_LOG=/dev/null \
    bash "$SCRIPTS/relai-watch.sh" >"$posout" 2>&1 ) &
ppid=$!
sleep 1
kill -TERM "$ppid" 2>/dev/null; wait "$ppid" 2>/dev/null
out="$(cat "$posout")"; rm -f "$posout"
case "$out" in
  *"could not resolve"*) bad "a .mcp.json at the git root was not found from a subdirectory" ;;
  *) ok "a .mcp.json at the git root IS found from a subdirectory (walk isn't overcorrected)" ;;
esac
rm -rf "$walkdir"

# Symlinked git root: git rev-parse --show-toplevel returns a physical path,
# but $PWD can stay logical (macOS /tmp -> /private/tmp always does this) —
# comparing the two without resolving both let the walk climb to / on any
# such system, exactly what the "bounded at the enclosing repo" fix claims.
if [ "$(cd /tmp && pwd -P)" != "/tmp" ]; then
  symdir="$(mktemp -d)"
  mkdir -p "$symdir/real/repo/sub"
  cat >"$symdir/decoy.mcp.json.holder" <<'JSON'
{"mcpServers":{"relai":{"env":{"API_URL":"http://127.0.0.1:1","AGENT_ID":"agent_decoy2","API_SECRET":"decoy2"}}}}
JSON
  # Place the decoy exactly one physical level above the repo, then reach the
  # repo through a symlink whose logical path differs from the physical one.
  mv "$symdir/decoy.mcp.json.holder" "$(dirname "$symdir")/.mcp.json" 2>/dev/null || true
  ln -s "$symdir/real" "$symdir/link"
  # Backgrounded + killed, same reasoning as the decoy-above-root case above:
  # a broken bound means this enters the reconnect-forever loop, not a quick exit.
  symout="$(mktemp)"
  ( cd "$symdir/link/repo/sub" 2>/dev/null && API_URL= API_SECRET= AGENT_ID= RELAI_WATCH_LOG=/dev/null \
      bash "$SCRIPTS/relai-watch.sh" >"$symout" 2>&1 ) &
  ypid=$!
  sleep 1
  kill -TERM "$ypid" 2>/dev/null; wait "$ypid" 2>/dev/null
  out="$(cat "$symout")"; rm -f "$symout"
  rm -f "$(dirname "$symdir")/.mcp.json"
  # Same reasoning as the decoy-above-root case: silent (empty) output means
  # the decoy WAS picked up, so only the explicit rejection text passes.
  case "$out" in
    *"could not resolve"*) ok "walk stays bounded at the git root even when reached via a symlink" ;;
    *) bad "walk escaped the git root via a symlinked path component (out='${out:0:100}')" ;;
  esac
  rm -rf "$symdir"
else
  ok "symlink walk-bound test skipped (this machine's /tmp is not a symlink)"
fi

# --- API_URL scheme allowlist --------------------------------------------------
# A rejected scheme exits fast (checked before the connect loop). An accepted
# one runs relai-watch.sh's normal reconnect-forever loop, so it must be
# backgrounded and killed rather than awaited in the foreground.

runwatch() {
  local outfile; outfile="$(mktemp)"
  API_URL="$1" API_SECRET=t AGENT_ID=agent_x RELAI_WATCH_LOG=/dev/null \
    bash "$SCRIPTS/relai-watch.sh" >"$outfile" 2>&1 &
  local p=$!
  sleep 1
  kill -TERM "$p" 2>/dev/null; wait "$p" 2>/dev/null
  cat "$outfile"; rm -f "$outfile"
}

for scheme in 'file:///etc/passwd' 'javascript:alert(1)' 'ftp://x'; do
  out="$(runwatch "$scheme")"
  case "$out" in
    *"refusing a non-http"*) ok "API_URL scheme '$scheme' is rejected" ;;
    *) bad "API_URL scheme '$scheme' was not rejected (out='${out:0:80}')" ;;
  esac
done

out="$(runwatch '')"
case "$out" in
  *"refusing a non-http"*) bad "empty API_URL was rejected instead of falling back to the default" ;;
  *) ok "empty API_URL falls back to the http:// default rather than erroring" ;;
esac

# --- idempotency: at most one live watcher per agent --------------------------
# Each case below uses its own RELAI_WATCH_PIDFILE_DIR (on top of the file's
# global export), so nothing here can ever touch a real running watcher.

alive() { kill -0 "$1" 2>/dev/null; }

# The inverse of poll_until: wait for a condition to become false.
wait_until_false() {
  local i; for i in $(seq 1 50); do eval "$1" || return 0; sleep 0.1; done; return 1
}

# Poll rather than sleep for a pidfile to exist and (optionally) hold a pid
# other than $2, so this doesn't race the second watcher's own startup.
poll_pidfile_pid() {
  local file="$1" not="${2:-}" i
  for i in $(seq 1 50); do
    if [ -s "$file" ]; then
      local p; p="$(cat "$file" 2>/dev/null || true)"
      [ -n "$p" ] && [ "$p" != "$not" ] && { printf '%s' "$p"; return 0; }
    fi
    sleep 0.1
  done
  return 1
}

if start_server -1 25; then
  piddir="$(mktemp -d)"
  agent="agent_dup_$$"

  RELAI_WATCH_PIDFILE_DIR="$piddir" RELAI_WATCH_LOG=/dev/null RELAI_WATCH_WINDOW=30 RELAI_WATCH_BACKOFF=1 \
    API_URL="http://127.0.0.1:$PORT" API_SECRET=t AGENT_ID="$agent" \
    bash "$SCRIPTS/relai-watch.sh" >/dev/null 2>&1 &
  a_wrapper=$!
  pidfile="$piddir/watch-$agent.pid"
  pid_a="$(poll_pidfile_pid "$pidfile")"

  if [ -n "$pid_a" ] && alive "$pid_a"; then
    RELAI_WATCH_PIDFILE_DIR="$piddir" RELAI_WATCH_LOG=/dev/null RELAI_WATCH_WINDOW=30 RELAI_WATCH_BACKOFF=1 \
      API_URL="http://127.0.0.1:$PORT" API_SECRET=t AGENT_ID="$agent" \
      bash "$SCRIPTS/relai-watch.sh" >/dev/null 2>&1 &
    b_wrapper=$!
    pid_b="$(poll_pidfile_pid "$pidfile" "$pid_a")"

    if [ -n "$pid_b" ]; then
      ! alive "$pid_a" && ok "relaunching for the same agent terminates the first watcher" \
        || bad "the first watcher is still alive after a second one started"
      alive "$pid_b" && ok "the second watcher becomes the sole live one" \
        || bad "the second watcher is not alive after replacing the first"
    else
      bad "second watcher never wrote a (different) pid to the pidfile"
    fi

    # Kill both unconditionally, not just $b_wrapper/$pid_b: if the code under
    # test is broken and $pid_a is still alive, this is the only thing that
    # stops it leaking past this test.
    kill -TERM "$a_wrapper" "${pid_a:-}" "$b_wrapper" "${pid_b:-}" 2>/dev/null
    wait "$a_wrapper" "$b_wrapper" 2>/dev/null
    wait_until_false '[ -f "$pidfile" ]'
    [ -f "$pidfile" ] && bad "pidfile not removed after the sole watcher exited" \
      || ok "pidfile is removed on clean signal exit"
  else
    bad "first watcher never wrote a live pid to the pidfile — could not run the replace test"
    kill -TERM "$a_wrapper" 2>/dev/null; wait "$a_wrapper" 2>/dev/null
  fi
  rm -rf "$piddir"
  stop_server
fi

if start_server -1 25; then
  piddir="$(mktemp -d)"
  agent="agent_stale_$$"
  pidfile="$piddir/watch-$agent.pid"

  # A pid guaranteed dead: spawn, wait for it to actually exit, reuse its number.
  ( exit 0 ) & dead_pid=$!; wait "$dead_pid" 2>/dev/null
  mkdir -p "$piddir"
  printf '%s' "$dead_pid" > "$pidfile"

  RELAI_WATCH_PIDFILE_DIR="$piddir" RELAI_WATCH_LOG=/dev/null RELAI_WATCH_WINDOW=30 RELAI_WATCH_BACKOFF=1 \
    API_URL="http://127.0.0.1:$PORT" API_SECRET=t AGENT_ID="$agent" \
    bash "$SCRIPTS/relai-watch.sh" >/dev/null 2>&1 &
  c_wrapper=$!
  pid_c="$(poll_pidfile_pid "$pidfile" "$dead_pid")"

  [ -n "$pid_c" ] && alive "$pid_c" && ok "a stale pidfile (dead pid) does not block startup" \
    || bad "startup was blocked (or failed) by a stale pidfile"

  kill -TERM "$c_wrapper" "${pid_c:-}" 2>/dev/null; wait "$c_wrapper" 2>/dev/null
  wait_until_false '[ -n "${pid_c:-}" ] && alive "$pid_c"'
  rm -rf "$piddir"
  stop_server
fi

if start_server 1; then
  piddir="$(mktemp -d)"
  agent="agent_event_$$"
  pidfile="$piddir/watch-$agent.pid"
  eventout="$(mktemp)"

  RELAI_WATCH_PIDFILE_DIR="$piddir" RELAI_WATCH_LOG=/dev/null \
    API_URL="http://127.0.0.1:$PORT" API_SECRET=t AGENT_ID="$agent" \
    bash "$SCRIPTS/relai-watch.sh" >"$eventout" 2>/dev/null &
  ewrapper=$!

  # Non-vacuous: confirms the pidfile actually held a live pid WHILE running,
  # not just that it's absent afterward (which a pidfile that was never
  # created would also satisfy).
  pid_e="$(poll_pidfile_pid "$pidfile")"
  [ -n "$pid_e" ] && alive "$pid_e" && ok "the pidfile names a live pid while the watcher is running" \
    || bad "pidfile never appeared with a live pid before the event fired"

  wait "$ewrapper"
  out="$(cat "$eventout")"; rm -f "$eventout"
  case "$out" in *evt_test*) ok "a real event still ends the wait with the pidfile mechanism active" ;;
    *) bad "event not returned with pidfile idempotency active (got '${out:0:60}')" ;; esac
  [ -f "$pidfile" ] && bad "pidfile not removed after a clean (event) exit" \
    || ok "pidfile is removed after a clean (event) exit"
  rm -rf "$piddir"
  stop_server
fi

# Ownership guard: exiting must not delete a pidfile that no longer names
# this process — simulated directly (racing two real launches isn't deterministic).
if start_server -1 25; then
  piddir="$(mktemp -d)"
  agent="agent_owner_$$"
  pidfile="$piddir/watch-$agent.pid"

  RELAI_WATCH_PIDFILE_DIR="$piddir" RELAI_WATCH_LOG=/dev/null RELAI_WATCH_WINDOW=30 RELAI_WATCH_BACKOFF=1 \
    API_URL="http://127.0.0.1:$PORT" API_SECRET=t AGENT_ID="$agent" \
    bash "$SCRIPTS/relai-watch.sh" >/dev/null 2>&1 &
  o_wrapper=$!
  pid_o="$(poll_pidfile_pid "$pidfile")"

  if [ -n "$pid_o" ] && alive "$pid_o"; then
    foreign="99999"
    printf '%s' "$foreign" > "$pidfile"
    kill -TERM "$o_wrapper" "$pid_o" 2>/dev/null
    wait_until_false 'alive "$pid_o"'

    [ "$(cat "$pidfile" 2>/dev/null)" = "$foreign" ] \
      && ok "exiting does not touch a pidfile entry that no longer names this process" \
      || bad "exit removed or overwrote a pidfile entry already claimed by another instance"
  else
    bad "watcher never wrote a live pid to the pidfile — could not run the ownership-guard test"
    kill -TERM "$o_wrapper" 2>/dev/null; wait "$o_wrapper" 2>/dev/null
  fi
  rm -rf "$piddir"
  stop_server
fi

# The race itself: two simultaneous relaunches must leave exactly one live
# watcher — the exact failure this whole guard exists to prevent.
if start_server -1 25; then
  piddir="$(mktemp -d)"
  agent="agent_race_$$"
  pidfile="$piddir/watch-$agent.pid"
  common_env=(RELAI_WATCH_PIDFILE_DIR="$piddir" RELAI_WATCH_LOG=/dev/null RELAI_WATCH_WINDOW=30 RELAI_WATCH_BACKOFF=1 \
    API_URL="http://127.0.0.1:$PORT" API_SECRET=t AGENT_ID="$agent")

  env "${common_env[@]}" bash "$SCRIPTS/relai-watch.sh" >/dev/null 2>&1 &
  a_wrapper=$!
  pid_a="$(poll_pidfile_pid "$pidfile")"

  if [ -n "$pid_a" ] && alive "$pid_a"; then
    env "${common_env[@]}" bash "$SCRIPTS/relai-watch.sh" >/dev/null 2>&1 &
    b_wrapper=$!
    env "${common_env[@]}" bash "$SCRIPTS/relai-watch.sh" >/dev/null 2>&1 &
    c_wrapper=$!

    survivors=""
    for _ in $(seq 1 50); do
      survivors="$(pgrep -f "relai-stream-wait\.sh .*$agent" 2>/dev/null || true)"
      count="$(printf '%s\n' "$survivors" | grep -c . || true)"
      [ "$count" -le 1 ] 2>/dev/null && break
      sleep 0.1
    done
    [ "$count" = "1" ] && ok "two simultaneous relaunches racing one incumbent leave exactly one live watcher" \
      || bad "the race left $count live watcher(s) for one agent instead of exactly 1"

    for p in $survivors; do kill -TERM "$p" 2>/dev/null; done
    kill -TERM "$a_wrapper" "$b_wrapper" "$c_wrapper" 2>/dev/null
    wait "$a_wrapper" "$b_wrapper" "$c_wrapper" 2>/dev/null
  else
    bad "incumbent watcher never wrote a live pid to the pidfile — could not run the race test"
    kill -TERM "$a_wrapper" 2>/dev/null; wait "$a_wrapper" 2>/dev/null
  fi
  rm -rf "$piddir"
  stop_server
fi
# --- the SessionStart hook: what it tells a woken agent to do -----------------
# The hook is the only thing that decides what a wake COSTS. An external kill
# (Claude Code reaps background tasks on a ~30-min per-session grid) wakes the
# agent with no event to reconcile, so an unconditional session_start there is
# pure waste — measured at 5 spurious wakes in one session on 2026-08-27.

hookdir="$(mktemp -d)"
hook_ctx() { RELAI_DIR="$SCRIPTS/.." CLAUDE_PROJECT_DIR="$1" bash "$SCRIPTS/relai-watch-hook.sh" 2>/dev/null; }

out="$(hook_ctx "$hookdir")"
check "no .mcp.json means the hook injects nothing" "${out:-empty}" "empty"

printf '{"mcpServers":{"other":{}}}' > "$hookdir/.mcp.json"
out="$(hook_ctx "$hookdir")"
check "a repo not wired to relai injects nothing" "${out:-empty}" "empty"

printf '{"mcpServers":{"relai":{"command":"tsx"}}}' > "$hookdir/.mcp.json"
out="$(hook_ctx "$hookdir")"
kind="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).hookSpecificOutput.hookEventName)}catch(e){process.stdout.write("unparseable")}})')"
check "a wired repo gets valid SessionStart JSON" "$kind" "SessionStart"

ctx="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).hookSpecificOutput.additionalContext)}catch(e){process.stdout.write("")}})')"

# The expensive call must be conditional on an event actually having arrived.
case "$ctx" in
  *'session_start FIRST'*) bad "hook still orders session_start unconditionally on every wake" ;;
  *) ok "hook does not order session_start unconditionally" ;;
esac

case "$ctx" in
  *'[killed]'*) ok "hook names the [killed] marker so a spurious wake is recognisable" ;;
  *) bad "hook gives the agent no way to tell an external kill from a real event" ;;
esac

case "$ctx" in
  *'exits only when'*) bad "hook still claims the watcher exits only on a real event — an external kill also exits it" ;;
  *) ok "hook does not claim a real event is the only exit" ;;
esac

# Relaunching has to survive both paths, or the session stops waking entirely.
case "$ctx" in
  *[Rr]elaunch*) ok "hook still tells the agent to relaunch the watcher" ;;
  *) bad "hook dropped the relaunch instruction" ;;
esac

rm -rf "$hookdir"


printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
