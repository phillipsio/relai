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

# A watcher this suite backgrounded: our own process group, and a real
# `bash <path>/relai-watch.sh` argv, since a zsh -c wrapper carries it as data.
SUITE_PGID="$(ps -p $$ -o pgid= | tr -d ' ')"
watch_pids() {
  ps -Ao pid=,pgid=,args= |
    awk -v g="$SUITE_PGID" '$2==g && $3 ~ /(^|\/)bash$/ && $4 ~ /relai-watch\.sh$/ { print $1 }'
}
PRE_EXISTING=" $(watch_pids | tr '\n' ' ')"
suite_watchers() {
  local p
  for p in $(watch_pids); do
    case "$PRE_EXISTING" in *" $p "*) continue ;; esac
    printf '%s\n' "$p"
  done
}

trap 'kill "${SRV_PID:-}" 2>/dev/null; [ -n "${SCRATCH:-}" ] && rm -rf "$SCRATCH"; rm -rf "$PIDFILE_SCRATCH"; for p in $(suite_watchers); do kill -TERM "$p" 2>/dev/null; done' EXIT INT TERM

ok()   { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

start_server() {
  local emit="${1:--1}" ping="${2:-0.25}" agents="${3:-200}" out
  out="$(mktemp)"
  python3 "$HERE/fake-sse-server.py" "$emit" "$ping" "$agents" >"$out" 2>/dev/null &
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

# Credentials unset so only .mcp.json resolution is under test. exec is
# load-bearing: without it $! names the subshell and the kill misses the leaf.
bg_watcher() {
  ( cd "$1" 2>/dev/null && API_URL= API_SECRET= AGENT_ID= RELAI_WATCH_LOG=/dev/null \
      exec bash "$SCRIPTS/relai-watch.sh" >"$2" 2>&1 ) &
}

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

# curl's config parser expands backslash escapes inside a QUOTED value, so the
# two PRINTABLE characters \ and n become a real newline after the [:print:]
# guard has passed the value. Measured: the header break plus a pipelined
# request reached the server on all three calls (validate, subscribe, stream).
# A real token is aio_ + base64url, so neither character is ever legitimate.
out="$(RELAI_TOKEN='tok\r\nX-Injected: 1' bash "$SCRIPTS/relai-stream-wait.sh" http://127.0.0.1:1 agent_x 1 2>&1)"
[ "$?" -ne 0 ] && ok "a token containing a backslash escape is rejected (curl expands it to a newline)" \
  || bad "backslash-bearing token was accepted: curl will expand \\r\\n into a real header break"

out="$(RELAI_TOKEN='tok" user-agent "PWNED' bash "$SCRIPTS/relai-stream-wait.sh" http://127.0.0.1:1 agent_x 1 2>&1)"
[ "$?" -ne 0 ] && ok "a token containing a double quote is rejected (it terminates the config value)" \
  || bad "quote-bearing token was accepted"

# Do not over-reject: the real token charset must still pass. aio_ + base64url.
# Assert it got PAST the guard, not that a particular refusal string is absent:
# rewording the refusal would otherwise make this pass while every real token is
# rejected. A connection failure to port 1 only happens after curl is reached.
out="$(RELAI_TOKEN='aio_AbC-123_xyzAbC-123_xyz' bash "$SCRIPTS/relai-stream-wait.sh" http://127.0.0.1:1 agent_x 1 2>&1)"
case "$out" in
  *"Failed to connect"*|*"Connection refused"*|*"couldn't connect"*)
    ok "a legitimate aio_ token reaches curl, so the guard does not over-reject" ;;
  *) bad "a legitimate aio_ token never reached curl (out='${out:0:100}')" ;;
esac

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
# The credential guard now runs first and catches the quote, so either refusal
# is correct here; the property is that relai-watch.sh refuses it at all.
case "$out" in
  *"doesn't look like an agent id"*|*"outside [A-Za-z0-9_-]"*|*"backslash or quote"*)
    ok "relai-watch.sh itself rejects a malformed AGENT_ID from .mcp.json" ;;
  *) bad "malformed AGENT_ID from .mcp.json was not rejected by relai-watch.sh (out='${out:0:100}')" ;;
esac

# A charset offender with NO quote or backslash, so the AGENT_ID guard itself is
# still exercised rather than shadowed by the credential guard above it.
mcpdir2="$(mktemp -d)"
cat >"$mcpdir2/.mcp.json" <<'JSON'
{"mcpServers":{"relai":{"env":{"API_URL":"http://127.0.0.1:1","AGENT_ID":"agent_x;evil","API_SECRET":"t"}}}}
JSON
badout2="$(mktemp)"
( API_URL= API_SECRET= AGENT_ID= bash "$SCRIPTS/relai-watch.sh" --repo-path "$mcpdir2" >"$badout2" 2>&1 ) &
bpid2=$!
sleep 1
kill -TERM "$bpid2" 2>/dev/null; wait "$bpid2" 2>/dev/null
out2="$(cat "$badout2")"; rm -f "$badout2"; rm -rf "$mcpdir2"
case "$out2" in
  *"outside [A-Za-z0-9_-]"*) ok "the AGENT_ID charset guard still fires on an offender with no quote" ;;
  *) bad "AGENT_ID charset guard did not fire on 'agent_x;evil' (out='${out2:0:100}')" ;;
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
bg_watcher "$walkdir/outer/repo/sub" "$decout"
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
bg_watcher "$walkdir/repo/sub" "$posout"
ppid=$!
sleep 1
# Success here is silence (the watcher resolved creds and started looping), and
# so is never starting at all, so aliveness is what separates them.
kill -0 "$ppid" 2>/dev/null && running=1 || running=0
kill -TERM "$ppid" 2>/dev/null; wait "$ppid" 2>/dev/null
out="$(cat "$posout")"; rm -f "$posout"
case "$out" in
  *"could not resolve"*) bad "a .mcp.json at the git root was not found from a subdirectory" ;;
  *) check "a .mcp.json at the git root IS found from a subdirectory (walk isn't overcorrected)" "$running" 1 ;;
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
  bg_watcher "$symdir/link/repo/sub" "$symout"
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

# A watcher writes its pidfile before installing the EXIT trap that removes it,
# so signalling it earlier than its stream loop tests startup, not clean exit.
in_stream_loop() {
  local i c
  for i in $(seq 1 100); do
    for c in $(pgrep -P "$1" 2>/dev/null); do
      ps -p "$c" -o command= 2>/dev/null | grep -q 'relai-stream-wait\.sh' && return 0
    done
    sleep 0.1
  done
  return 1
}

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
    # Clean exit is only defined once the survivor owns its EXIT trap; killing
    # it mid-startup leaves the pidfile behind and is a different test.
    [ -n "${pid_b:-}" ] && in_stream_loop "$pid_b"
    # Deduplicated: a wrapper and the pid it writes to the pidfile are the same
    # process, so the unduplicated form sent TERM twice and the second one could
    # land inside the EXIT trap before it removed the pidfile.
    for p in $(printf '%s\n' "$a_wrapper" "${pid_a:-}" "$b_wrapper" "${pid_b:-}" | grep -v '^$' | sort -u); do
      kill -TERM "$p" 2>/dev/null
    done
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
    # Settle on exactly one. Zero is a legitimate transient, since the guard
    # TERMs the incumbent's child before the survivor spawns its own.
    for _ in $(seq 1 50); do
      survivors="$(pgrep -f "relai-stream-wait\.sh .*$agent" 2>/dev/null || true)"
      count="$(printf '%s\n' "$survivors" | grep -c . || true)"
      [ "$count" = "1" ] && break
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
hook_ctx() { RELAI_DIR="$SCRIPTS/.." CLAUDE_PROJECT_DIR="$1" env API_URL= API_SECRET= AGENT_ID= bash "$SCRIPTS/relai-watch-hook.sh" --event=SessionStart </dev/null 2>/dev/null; }
# A Stop call with a payload on stdin, the shape Claude Code actually sends
# (captured from a live Stop on 2026-09-17: session_id, stop_hook_active,
# background_tasks[{id,type,status,description,command}], …).
hook_stop_ctx() { printf '%s' "$2" | RELAI_DIR="$SCRIPTS/.." CLAUDE_PROJECT_DIR="$1" env API_URL= API_SECRET= AGENT_ID= bash "$SCRIPTS/relai-watch-hook.sh" --event=Stop 2>/dev/null; }
stop_payload() { # $1 = stop_hook_active, $2 = a task command ("" for none)
  if [ -n "$2" ]; then
    printf '{"hook_event_name":"Stop","stop_hook_active":%s,"background_tasks":[{"id":"t","type":"shell","status":"running","command":"%s"}]}' "$1" "$2"
  else
    printf '{"hook_event_name":"Stop","stop_hook_active":%s,"background_tasks":[]}' "$1"
  fi
}
hook_field() { printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).hookSpecificOutput[process.argv[1]]))}catch(e){process.stdout.write("unparseable")}})' "$2"; }

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

# --- the claim must not come back anywhere, not just in the hook -------------
# Correcting the hook did not converge: the same false claim survived in the
# script header, the setup doc and the design doc, in wordings a grep for the
# hook's exact sentence never matched. This guard greps the CLAIM, not one
# spelling of it, across everything an agent or operator might read.

claim_hits="$(cd "$SCRIPTS/.." && grep -rn --include="*.md" --include="*.sh" -iE \
  "exits? \*{0,2}only\*{0,2} (on|when)|woken \*{0,2}only\*{0,2} by|only when a real (relai )?event" . 2>/dev/null \
  | grep -v node_modules | grep -v 'scripts/tests/' || true)"
if [ -z "$claim_hits" ]; then
  ok "no file claims the watcher exits only on a real event"
else
  bad "the 'exits only on a real event' claim survives in: $(printf '%s' "$claim_hits" | cut -d: -f1,2 | tr '\n' ' ')"
fi

ctx_reload="$ctx"

# --- classification must key on the event, not on the shape of a kill --------
# Real output seen 2026-08-28T01:13:43Z: "[killed]" plus a bash job-status line
# ("Abort trap: 6") because the child died on SIGABRT after its TERM trap ran.
# 212 bytes, not the 10 a plain reap gives. An agent matching CASE 2 on "empty
# or just [killed]" finds neither case matches and is left to guess, on the one
# path where guessing wrong costs a wasted reconcile every 30 minutes.

case "$ctx_reload" in
  *'empty or just'*) bad "hook classifies a kill by exact output shape, so any extra stderr line falls through both cases" ;;
  *) ok "hook does not classify a kill by exact output shape" ;;
esac

# The positive test is what makes it decidable: presence of event JSON, and
# nothing else, separates the two.
case "$ctx_reload" in
  *'no event JSON'*|*'without event JSON'*|*'contains no event JSON'*)
    ok "hook decides on the presence of event JSON, so unexpected output still classifies" ;;
  *) bad "hook gives no rule for output that is neither empty nor a bare [killed]" ;;
esac

# The watcher can now exit deliberately on a config the API rejects. Without a
# rule for it the hook's own "anything else is CASE 2" sends the agent to
# relaunch a permanent failure, once per turn, forever.
# One LINE must carry both the marker and the instruction. Grepping the whole
# text for either alone passes after the rule is deleted, because the marker
# survives in the tie-breaking sentence and "relaunch" survives in CASE 2.
if printf '%s' "$ctx_reload" | grep -qi 'RELAI-CONFIG-REFUSED.*not relaunch'; then
  ok "hook's config-refusal rule names the marker and says not to relaunch"
else
  bad "hook has no single rule pairing RELAI-CONFIG-REFUSED with not relaunching, so a rejected AGENT_ID loops"
fi

# The marker appears in peer-authored event payloads (message bodies, task
# titles), so a rule that outranks the event-JSON check turns a real wake into a
# false refusal. The rule must be subordinate: no event JSON, THEN the marker.
if printf '%s' "$ctx_reload" | grep -qi 'no event JSON and the output contains RELAI-CONFIG-REFUSED'; then
  ok "hook's refusal rule is subordinate to the event-JSON check"
else
  bad "hook's refusal rule does not require the absence of event JSON, so a task titled after the marker silences a real event"
fi
case "$ctx_reload" in
  *'event JSON FIRST'*|*'event JSON first'*) ok "…and the hook states that ordering explicitly" ;;
  *) bad "hook does not tell the agent to decide the event JSON before the marker" ;;
esac


# --- AGENT_ID must RESOLVE, not merely look well formed -----------------------
# The shape check above passes a truncated id, because a truncated agent id is
# still a well-formed one. The watcher then subscribes to an agent that does not
# exist, and a subscription to nobody looks exactly like a quiet one, which is
# how a live Cursor worker was diagnosed as broken. The pidfile is keyed on
# AGENT_ID too, so the single-instance guard cannot notice: the typo'd watcher
# gets its own pidfile and runs happily beside the real one.

# Bounded: before the check exists the watcher proceeds to the stream and never
# returns, and macOS has no `timeout`. exec so $! is the leaf, not the subshell.
watch_until_exit() { # outfile, agent, api_url [, logfile] -> RC = exit, or "running"
  local out="$1" agent="$2" url="$3" log="${4:-/dev/null}" pid i
  ( API_URL="$url" API_SECRET=t AGENT_ID="$agent" RELAI_WATCH_LOG="$log" \
      exec bash "$SCRIPTS/relai-watch.sh" >"$out" 2>&1 ) &
  pid=$!
  for i in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || { wait "$pid"; RC=$?; return; }
    sleep 0.1
  done
  kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  RC=running
}

# 401 carries the deleted-agent case: tokens cascade on agent delete, so a
# deleted agent 401s at the auth plugin and never reaches the 404 this check was
# written for. All three are the API answering about this credential.
for status in 401 403 404; do
  if start_server -1 0.25 "$status"; then
    vout="$(mktemp)"; vlog="$(mktemp)"
    watch_until_exit "$vout" agent_ghostid "http://127.0.0.1:$PORT" "$vlog"
    stop_server
    case "$RC" in
      running) bad "a $status from GET /agents/:id did not stop the watcher" ;;
      1)       ok  "a $status from GET /agents/:id refuses to start" ;;
      *)       bad "a $status refused with rc=$RC, expected 1 like every other config guard" ;;
    esac
    # Ordering, asserted on the log, not the pidfile. Under the wrong ordering
    # the pidfile IS created and then removed by the EXIT trap on the way out,
    # so its absence afterwards looks identical either way. watcher-start is
    # logged only once the pidfile is held, so its absence separates them.
    if grep -q "agent-validate refusing reason=$status" "$vlog"; then
      ok "a refused $status start records the refusal in the log"
    else
      bad "no agent-validate refusal logged for $status (log='$(tr '\n' ' ' < "$vlog" | head -c 120)')"
    fi
    if grep -q 'watcher-start' "$vlog"; then
      bad "a refused $status start still reached watcher-start, so it ran after the pidfile was taken"
    else
      ok "a refused $status start never reaches watcher-start, so it runs before the pidfile is taken"
    fi
    rm -f "$vout" "$vlog"
  fi
done

# The refusal must carry the marker the SessionStart hook keys CASE 3 on, or the
# consumer is told by its own instructions to relaunch a permanent failure.
if start_server -1 0.25 404; then
  vout="$(mktemp)"
  watch_until_exit "$vout" agent_ghostid "http://127.0.0.1:$PORT"
  stop_server
  grep -q 'RELAI-CONFIG-REFUSED' "$vout" \
    && ok "the refusal carries the RELAI-CONFIG-REFUSED marker the hook matches" \
    || bad "refusal lacks RELAI-CONFIG-REFUSED (out='$(head -c 120 "$vout" | tr '\n' ' ')')"
  grep -q 'agent_ghostid' "$vout" \
    && ok "…and names the agent id" \
    || bad "the refusal does not name the agent id"
  rm -f "$vout"
fi

# relai-watch.sh validates its own sources before ever calling the child, so the
# same escape has to be refused here too, with the marker.
# Bounded: before the guard exists these values are ACCEPTED and the watcher
# goes into its reconnect loop forever, which hangs the whole suite.
cred_refused() { # payload -> RC ("running" if it never exited), output in $CRED_OUT
  local payload="$1" pid i
  CRED_OUT="$(mktemp)"
  CRED_LOG="$(mktemp)"; rm -f "$CRED_LOG"   # must STAY absent if we refuse early
  ( API_URL=http://127.0.0.1:1 API_SECRET="$payload" AGENT_ID=agent_x \
      RELAI_WATCH_LOG="$CRED_LOG" exec bash "$SCRIPTS/relai-watch.sh" >"$CRED_OUT" 2>&1 ) &
  pid=$!
  for i in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || { wait "$pid"; RC=$?; return; }
    sleep 0.1
  done
  kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  RC=running
}

for payload in 'tok\r\nX-Injected: 1' 'tok" user-agent "PWNED'; do
  cred_refused "$payload"
  label="$(printf '%s' "$payload" | cut -c1-9)"
  case "$RC" in
    running|0) bad "relai-watch accepted a credential containing '$label' that curl re-expands" ;;
    *)         ok "relai-watch refuses a credential containing '$label' before any request" ;;
  esac
  if grep -q 'RELAI-CONFIG-REFUSED' "$CRED_OUT"; then
    ok "…and marks it so the hook does not relaunch it"
  else
    bad "credential refusal for '$label' lacks the marker"
  fi
  # Ordering: the log is set up AFTER the credential guards, so if the refusal
  # came first the file was never created. Without this, moving the guard below
  # validate_agent_id keeps every assertion above green while the split header
  # goes out on the first request.
  if [ -e "$CRED_LOG" ]; then
    bad "credential refusal for '$label' happened after logging started, so a request may already have gone out"
  else
    ok "…and refuses before the watcher does anything else"
  fi
  rm -f "$CRED_OUT" "$CRED_LOG"
done

# The guard covers all three config values, not just API_SECRET. Without this,
# hoisting the AGENT_ID charset guard above the credential loop would go unnoticed.
uout="$(API_URL='https://example.com/a\b' API_SECRET=t AGENT_ID=agent_x \
          RELAI_WATCH_LOG=/dev/null bash "$SCRIPTS/relai-watch.sh" 2>&1)"
case "$uout" in
  *"API_URL from config contains a backslash or quote"*)
    ok "the credential guard covers API_URL, not only API_SECRET" ;;
  *) bad "a backslash in API_URL was not refused by name (out='${uout:0:100}')" ;;
esac

# The marker belongs to the whole config-refusal class, not just the API check.
# Attaching it to one of several permanent exits leaves the commonest failure,
# a repo with a relai block but no AGENT_ID yet, looping on relaunch forever.
mdir="$(mktemp -d)"
cat > "$mdir/.mcp.json" <<'MCPEOF'
{"mcpServers":{"relai":{"env":{"API_URL":"http://127.0.0.1:1"}}}}
MCPEOF
mout="$(mktemp)"
( cd "$mdir" && API_URL= API_SECRET= AGENT_ID= RELAI_WATCH_LOG=/dev/null \
    bash "$SCRIPTS/relai-watch.sh" >"$mout" 2>&1 )
mrc=$?
[ "$mrc" -eq 1 ] && ok "unresolved credentials refuse with the config-guard exit code" \
  || bad "unresolved credentials exited $mrc, expected 1"
grep -q 'RELAI-CONFIG-REFUSED' "$mout" \
  && ok "…and carry the marker, so the hook does not tell the agent to relaunch it" \
  || bad "unresolved credentials refuse WITHOUT the marker, so the hook loops on it (out='$(head -c 100 "$mout" | tr '\n' ' ')')"
rm -rf "$mdir" "$mout"

# Fail OPEN on anything inconclusive, and prove the check actually RAN rather
# than just that the process stayed alive: "still running after 5s" is equally
# true of a deleted validate_agent_id.
vout="$(mktemp)"; vlog="$(mktemp)"
watch_until_exit "$vout" agent_unreachable "http://127.0.0.1:1" "$vlog"
case "$RC" in
  running) ok "an unreachable API does not refuse the agent id" ;;
  *)       bad "an unreachable API refused the agent id (rc=$RC)" ;;
esac
grep -q 'agent-validate proceeding reason=' "$vlog" \
  && ok "…and the check ran and logged a verdict rather than being skipped" \
  || bad "no agent-validate verdict logged on the unreachable path"
rm -f "$vout" "$vlog"

if start_server -1 0.25 200; then
  vout="$(mktemp)"; vlog="$(mktemp)"
  watch_until_exit "$vout" agent_realid "http://127.0.0.1:$PORT" "$vlog"
  stop_server
  case "$RC" in
    running) ok "a 200 from GET /agents/:id lets the watcher proceed" ;;
    *)       bad "a 200 from GET /agents/:id stopped the watcher (rc=$RC)" ;;
  esac
  grep -q 'agent-validate proceeding reason=200' "$vlog" \
    && ok "…and logs the 200 verdict, so the check is not being skipped" \
    || bad "no agent-validate reason=200 logged"
  rm -f "$vout" "$vlog"
fi

# A server that accepts and never answers. Without --max-time the watcher hangs
# here forever with the suite green; with it, curl gives up and the watcher
# proceeds to watcher-start. Asserted on reaching watcher-start, not on elapsed
# time, so a loaded machine cannot flake it.
if start_server -1 0.25 0; then
  vout="$(mktemp)"; vlog="$(mktemp)"
  ( API_URL="http://127.0.0.1:$PORT" API_SECRET=t AGENT_ID=agent_stalled RELAI_WATCH_LOG="$vlog" \
      exec bash "$SCRIPTS/relai-watch.sh" >"$vout" 2>&1 ) &
  spid=$!
  reached=1
  for _ in $(seq 1 200); do
    grep -q 'watcher-start' "$vlog" 2>/dev/null && { reached=0; break; }
    sleep 0.1
  done
  kill -TERM "$spid" 2>/dev/null; wait "$spid" 2>/dev/null
  stop_server
  [ "$reached" -eq 0 ] \
    && ok "a stalled /agents/:id is bounded by --max-time and the watcher still starts" \
    || bad "the watcher never reached watcher-start against a stalled endpoint: the validate curl is unbounded"
  rm -f "$vout" "$vlog"
fi

# A trailing slash in API_URL must not produce a green check on a watcher that
# cannot deliver: relai-stream-wait.sh concatenates "$API_URL/events", so an
# unstripped slash yields //events, which the API does not route.
if start_server -1 0.25 200; then
  vout="$(mktemp)"; vlog="$(mktemp)"
  watch_until_exit "$vout" agent_realid "http://127.0.0.1:$PORT//" "$vlog"
  stop_server
  # api= is followed by more fields, so match slash-then-space. Anchoring on end
  # of line matches nothing and would pass unconditionally.
  startline="$(grep -o 'watcher-start api=[^ ]*' "$vlog" | head -1)"
  if [ -z "$startline" ]; then
    bad "no watcher-start line to check for a trailing slash (control failed)"
  elif printf '%s' "$startline" | grep -qE '/$'; then
    bad "a trailing slash survived into the watch path ($startline)"
  else
    ok "trailing slashes are stripped from API_URL before the check and the stream ($startline)"
  fi
  rm -f "$vout" "$vlog"
fi


# --- the token must never reach argv, including on short-lived calls ----------
# The runtime argv checks above can only catch a call that stays open long
# enough to appear in ps. The agent-id validation is a sub-second request, so
# polling for it would be a race; assert the property in the source instead,
# which also covers whatever curl someone adds next.
wake_scripts="$SCRIPTS/relai-watch.sh $SCRIPTS/relai-stream-wait.sh"
hdr_offenders=""
kcfg_seen=0
for f in $wake_scripts; do
  # Control: these files must actually be readable and use -K, or a clean
  # negative below would only mean the grep matched nothing at all.
  grep -q -- '-K' "$f" && kcfg_seen=$((kcfg_seen+1))
  # Both spellings: --header is the same leak as -H and would otherwise pass.
  if grep -qE -- '(-H|--header)[[:space:]]*"?Authorization' "$f"; then
    hdr_offenders="$hdr_offenders ${f##*/}"
  fi
done
if [ "$kcfg_seen" -eq 2 ]; then
  ok "control: both wake-path scripts were read and use a -K config file"
else
  bad "control failed: expected 2 wake-path scripts using -K, saw $kcfg_seen"
fi
if [ -z "$hdr_offenders" ]; then
  ok "no wake-path curl passes the token with -H, which would put it in ps"
else
  bad "Authorization passed via -H (token lands in argv):$hdr_offenders"
fi


# --- --check: the Stop hook's liveness probe ---------------------------------
# SessionStart fires once per session, but the watcher exits on EVERY successful
# wake by design, so relaunching used to depend on the agent remembering at the
# moment it had just been handed new work. Two orchestrators lost 11 and 14
# hours of coverage to that on 2026-09-17. The Stop hook closes it, and these
# cover the probe it decides on.

# Every invocation below scrubs API_URL/API_SECRET/AGENT_ID, because the watcher
# prefers env over .mcp.json by design and a dev checkout's .env exports two of
# them: inherited, they rename the pidfile these fixtures write and make the
# unresolvable-config case resolve. `probe` exists so no call can forget.
probe() { env API_URL= API_SECRET= AGENT_ID= "$@"; }

checkdir="$(mktemp -d)"
# 10.255.255.1 is unroutable, so a call that DID reach the API would pay the full
# --max-time. 127.0.0.1:1 refuses instantly and cannot tell the two apart.
printf '{"mcpServers":{"relai":{"env":{"API_URL":"http://10.255.255.1:3010","API_SECRET":"aio_test","AGENT_ID":"agent_checkprobe"}}}}' > "$checkdir/.mcp.json"

# No pidfile at all: the answer is "not running", and it must not start one.
out="$(RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" probe bash "$SCRIPTS/relai-watch.sh" --check --repo-path "$checkdir" 2>&1)"
check "--check reports not-running for the agent it resolved" "$out" "relai-watch: not running agent=agent_checkprobe"

# A pidfile naming a live process that is NOT a watcher must not read as alive:
# pids get reused, so the check confirms the process is really ours.
probe_dir="$(mktemp -d)"
sleep 30 & impostor=$!
echo "$impostor" > "$probe_dir/watch-agent_checkprobe.pid"
out="$(RELAI_WATCH_PIDFILE_DIR="$probe_dir" probe bash "$SCRIPTS/relai-watch.sh" --check --repo-path "$checkdir" 2>&1)"
check "--check rejects a pidfile pointing at some other live process" "$out" "relai-watch: not running agent=agent_checkprobe"
kill "$impostor" 2>/dev/null

# A stale pidfile (dead pid) is "not running", and --check must leave it alone:
# the start path owns that file under a lock, so a second writer would race it.
echo "999999" > "$probe_dir/watch-agent_checkprobe.pid"
out="$(RELAI_WATCH_PIDFILE_DIR="$probe_dir" probe bash "$SCRIPTS/relai-watch.sh" --check --repo-path "$checkdir" 2>&1)"
check "--check reports not-running on a stale pidfile" "$out" "relai-watch: not running agent=agent_checkprobe"
check "--check does not delete the stale pidfile it read" "$(cat "$probe_dir/watch-agent_checkprobe.pid" 2>/dev/null)" "999999"

# The probe must cost nothing: no request, so a dead API cannot make it hang or
# change its answer. The .mcp.json above points at a closed port on purpose.
probe_log="$(mktemp)"
probe_start=$(date +%s)
RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" RELAI_WATCH_LOG="$probe_log" \
  probe bash "$SCRIPTS/relai-watch.sh" --check --repo-path "$checkdir" >/dev/null 2>&1
probe_elapsed=$(( $(date +%s) - probe_start ))
if [ "$probe_elapsed" -le 2 ]; then
  ok "--check answers fast against an unroutable API (${probe_elapsed}s)"
else
  bad "--check took ${probe_elapsed}s — it is making a network call"
fi
if grep -q "agent-validate" "$probe_log" 2>/dev/null; then
  bad "--check logged an agent-validate line, so it did call the API"
else
  ok "…and logged no agent-validate line, so the call never happened"
fi

# --check composes with --repo-path, because Cursor passes the latter and the
# hook has to be able to ask about that same watcher.
out="$(RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" probe bash "$SCRIPTS/relai-watch.sh" --repo-path "$checkdir" --check 2>&1)"
check "--check works in either order with --repo-path" "$out" "relai-watch: not running agent=agent_checkprobe"

# `--repo-path` immediately followed by another flag must not eat it. This one
# was live: a `--repo-path --check` invocation took "--check" as the path, left
# check_only at 0, and STARTED a watcher, which then replaced the operator's
# running one through the single-instance path. A probe that starts a process is
# worse than a probe that answers wrong.
# Bounded, because the regression does not fail — it HANGS. With the guard
# removed, `--check` is consumed as the path value, check_only stays 0, and the
# script enters the wake loop and never returns, so an unbounded call turns a red
# test into a stuck suite (which is exactly what happened to three mutation runs
# on 2026-09-17 before this bound existed). Demonstrated on a mutated copy: it
# logged agent-validate + watcher-start and wrote watch-agent_mutprobe.pid.
probe_started_dir="$(mktemp -d)"
( RELAI_WATCH_PIDFILE_DIR="$probe_started_dir" CLAUDE_PROJECT_DIR="$checkdir" \
  probe bash "$SCRIPTS/relai-watch.sh" --repo-path --check >/dev/null 2>&1 ) &
probe_pp=$!
for _ in $(seq 1 50); do kill -0 "$probe_pp" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$probe_pp" 2>/dev/null; then
  kill -TERM "$probe_pp" 2>/dev/null
  bad "--repo-path --check never returned: it swallowed the flag and started a watcher"
else
  wait "$probe_pp"; probe_rc=$?
  check "--repo-path does not swallow a following --check" "$probe_rc" "1"
fi
if [ -z "$(ls -A "$probe_started_dir" 2>/dev/null)" ]; then
  ok "…and that form starts no watcher (no pidfile written)"
else
  bad "--repo-path --check started a watcher: $(ls -A "$probe_started_dir")"
fi

# A trailing --repo-path with no value at all must not crash or consume a phantom.
RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" CLAUDE_PROJECT_DIR="$checkdir" \
  probe bash "$SCRIPTS/relai-watch.sh" --check --repo-path >/dev/null 2>&1
check "a valueless trailing --repo-path still probes" "$?" "1"

# An unresolvable config refuses rather than answering "not running": a refusal
# is CASE 3, and reporting "not running" would have the hook relaunch forever.
# A relai server with NO env, so API_SECRET/AGENT_ID cannot resolve. Note a dir
# with no .mcp.json at all would NOT isolate this: the candidate list falls
# through to $CLAUDE_PROJECT_DIR and then the git root of $PWD, which is relai
# itself, and the probe would answer about the real agent.
emptydir="$(mktemp -d)"
printf '{"mcpServers":{"relai":{"command":"tsx"}}}' > "$emptydir/.mcp.json"
out="$(RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" CLAUDE_PROJECT_DIR="$emptydir" probe bash "$SCRIPTS/relai-watch.sh" --check --repo-path "$emptydir" 2>&1)"
case "$out" in
  *RELAI-CONFIG-REFUSED*) ok "--check refuses an unresolvable config instead of reporting not-running" ;;
  *) bad "--check on an unresolvable config said: ${out:-nothing}" ;;
esac

# --- the Stop hook: silent when healthy, loud only when the watcher is gone ---
# The liveness signal is this session's background_tasks, NOT the pidfile. The
# pidfile is written only after validate_agent_id's curl, so against a slow API
# it stays invisible for up to 6s (measured) while the hook keeps asking and
# each new watcher TERMs the last. background_tasks registers at launch.

stopdir="$(mktemp -d)"
printf '{"mcpServers":{"relai":{"env":{"API_URL":"http://10.255.255.1:3010","API_SECRET":"aio_test","AGENT_ID":"agent_stopprobe"}}}}' > "$stopdir/.mcp.json"

out="$(RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" hook_stop_ctx "$stopdir" "$(stop_payload false "")")"
check "Stop with no watcher task injects Stop-scoped JSON" "$(hook_field "$out" hookEventName)" "Stop"
case "$(hook_field "$out" additionalContext)" in
  *"NOT RUNNING"*) ok "…and the text says the watcher is not running" ;;
  *) bad "Stop context does not say the watcher is down" ;;
esac

# The common case, and the one that matters most: a per-turn hook that speaks
# when nothing is wrong costs a model turn every turn.
out="$(RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" hook_stop_ctx "$stopdir" "$(stop_payload false "/x/scripts/relai-watch.sh")")"
check "Stop is silent while a watcher task is running" "${out:-empty}" "empty"

# It must key on the watcher, not on "any background work exists".
out="$(RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" hook_stop_ctx "$stopdir" "$(stop_payload false "pnpm test")")"
check "an unrelated background task does not count as a watcher" "$(hook_field "$out" hookEventName)" "Stop"

# stop_hook_active is the documented bound. Without honouring it, any state that
# stays "gone" across a continuation multiplies by CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
# (8): a revoked token, a denied Bash call, a failed pidfile write.
out="$(RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" hook_stop_ctx "$stopdir" "$(stop_payload true "")")"
check "Stop is silent while stop_hook_active is true, even with no watcher" "${out:-empty}" "empty"

# No readable payload means no signal; fall back to the pidfile rather than
# asserting a watcher is gone on no evidence.
fallback_dir="$(mktemp -d)"
stub_dir="$(mktemp -d)"
printf '#!/usr/bin/env bash\nsleep 30\n' > "$stub_dir/relai-watch.sh"
bash "$stub_dir/relai-watch.sh" & stub_watcher=$!
echo "$stub_watcher" > "$fallback_dir/watch-agent_stopprobe.pid"
out="$(RELAI_WATCH_PIDFILE_DIR="$fallback_dir" hook_stop_ctx "$stopdir" 'not json')"
check "an unreadable payload falls back to the pidfile and stays silent" "${out:-empty}" "empty"
kill "$stub_watcher" 2>/dev/null

out="$(RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" hook_stop_ctx "$stopdir" 'not json')"
check "…and injects when that fallback also finds nothing" "$(hook_field "$out" hookEventName)" "Stop"

# The event comes from an argument now. Deriving it from the payload meant a
# partial read fell back to SessionStart, and Claude Code DROPS a
# hookSpecificOutput whose event name does not match the event it fired, so the
# original bug came back silently.
out="$(hook_ctx "$stopdir")"
check "SessionStart still injects unconditionally" "$(hook_field "$out" hookEventName)" "SessionStart"
out="$(printf '%s' "$(stop_payload false "")" | RELAI_DIR="$SCRIPTS/.." CLAUDE_PROJECT_DIR="$stopdir" RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" env API_URL= API_SECRET= AGENT_ID= bash "$SCRIPTS/relai-watch-hook.sh" 2>/dev/null)"
check "no --event argument defaults to SessionStart, as before this change" "$(hook_field "$out" hookEventName)" "SessionStart"

# A repo not wired to relai gets nothing on Stop either.
unwired="$(mktemp -d)"
printf '{"mcpServers":{"other":{}}}' > "$unwired/.mcp.json"
out="$(RELAI_WATCH_PIDFILE_DIR="$(mktemp -d)" hook_stop_ctx "$unwired" "$(stop_payload false "")")"
check "Stop injects nothing for a repo not wired to relai" "${out:-empty}" "empty"


# --- the suite must not outlive its own watchers -----------------------------
# A leaked wrapper logs to /dev/null and its pidfile dir is deleted, so it
# shows up in neither store. ps was the only place it was ever visible.
for _ in $(seq 1 30); do
  [ -z "$(suite_watchers)" ] && break
  sleep 0.1
done
leaked="$(suite_watchers | tr '\n' ' ' | sed 's/ *$//')"
if [ -z "$leaked" ]; then
  ok "the suite leaves no relai-watch.sh process behind"
else
  bad "the suite leaked relai-watch.sh (pids: $leaked)"
fi

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
