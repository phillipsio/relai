#!/usr/bin/env bash
# Drives `relai join` against a real API, start to finish, in a throwaway repo
# with HOME redirected. The parts that fail silently are all here: a config
# written to the wrong path, a token that does not authenticate, a merge that
# eats an existing MCP server. None of them are visible to a unit test.
#
#   DATABASE_URL=... packages/cli/scripts/test-join-e2e.sh
#
# Boots its own API on API_PORT (default 3021) so it cannot collide with a dev
# server on 3010, and tears it down on exit.
set -euo pipefail

PORT="${API_PORT:-3021}"
API="http://127.0.0.1:${PORT}"
ADMIN="e2e-service-admin-$$"
DB="${DATABASE_URL:-postgres://relai:relai@127.0.0.1:5433/relai}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SANDBOX="$(mktemp -d)"
API_PID=""
pass=0; fail=0

cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

check() { # name, condition-already-evaluated as $2 == "ok"
  if [ "$2" = "ok" ]; then pass=$((pass+1)); echo "PASS  $1"
  else fail=$((fail+1)); echo "FAIL  $1${3:+  ($3)}"; fi
}

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is in use; set API_PORT to something free"; exit 1
fi

DATABASE_URL="$DB" SERVICE_ADMIN_TOKEN="$ADMIN" API_SECRET="e2e-secret-$$" API_PORT="$PORT" \
  npx tsx "$ROOT/packages/api/src/index.ts" > "$SANDBOX/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 30); do curl -sf --max-time 2 "$API/livez" >/dev/null 2>&1 && break; sleep 1; done
curl -sf --max-time 2 "$API/livez" >/dev/null 2>&1 || { echo "API did not start"; tail -20 "$SANDBOX/api.log"; exit 1; }

OWNER="usr_e2e_$$"
psql_() { docker exec -e PGPASSWORD=relai relai-postgres-1 psql -U relai -d "${DB##*/}" -tA -c "$1" </dev/null; }
psql_ "insert into users (id, email) values ('$OWNER', '$OWNER@test.local') on conflict do nothing;" >/dev/null
REPO=$(curl -s -X POST "$API/repos" -H "Authorization: Bearer $ADMIN" -H "X-Owner-Id: $OWNER" \
  -H 'Content-Type: application/json' -d '{"name":"__e2e__ join"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["id"])')

# A throwaway repo with a remote, plus an existing .mcp.json holding a server
# that must survive, and a .cursor dir so cursor is detected.
WORK="$SANDBOX/work"; mkdir -p "$WORK/.cursor"
git -C "$WORK" init -q 2>/dev/null || (cd "$WORK" && git init -q)
git -C "$WORK" remote add origin "git@github.com:someone/e2e-widget.git"
printf '%s\n' '{"mcpServers":{"playwright":{"command":"npx","args":["playwright"]}},"theme":"dark"}' > "$WORK/.mcp.json"

export HOME="$SANDBOX/home"; mkdir -p "$HOME"
( cd "$WORK" && npx tsx "$ROOT/packages/cli/src/index.ts" join --api "$API" > "$SANDBOX/join.log" 2>&1 ) &
JOIN_PID=$!

CODE=""
for _ in $(seq 1 30); do
  CODE=$(grep -oE '[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}' "$SANDBOX/join.log" 2>/dev/null | head -1 || true)
  [ -n "$CODE" ] && break; sleep 1
done
[ -n "$CODE" ] && check "join prints a typeable code" ok || check "join prints a typeable code" no "$(tail -3 "$SANDBOX/join.log")"
grep -q "e2e-widget" "$SANDBOX/join.log" && check "join names the repo from the git remote" ok || check "join names the repo from the git remote" no
grep -q "cursor" "$SANDBOX/join.log" && check "join detects the cursor runtime" ok || check "join detects the cursor runtime" no

APPROVE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/device/approve" \
  -H "Authorization: Bearer $ADMIN" -H "X-Owner-Id: $OWNER" -H 'Content-Type: application/json' \
  -d "{\"userCode\":\"$CODE\",\"repoId\":\"$REPO\",\"agents\":[{\"name\":\"claude-code\",\"workerType\":\"claude\",\"role\":\"orchestrator\"},{\"name\":\"cursor\",\"workerType\":\"cursor\",\"role\":\"worker\",\"specialization\":\"reviewer\"}]}")
[ "$APPROVE" = "200" ] && check "approval is accepted" ok || check "approval is accepted" no "HTTP $APPROVE"

wait $JOIN_PID 2>/dev/null || true
grep -q "You're in" "$SANDBOX/join.log" && check "join reports success" ok || check "join reports success" no "$(tail -5 "$SANDBOX/join.log")"
grep -qE "2/2 agents exchanged a message" "$SANDBOX/join.log" && check "the two agents DM each other and read it back" ok || check "the two agents DM each other and read it back" no "$(grep -i 'exchanged' "$SANDBOX/join.log" || echo 'no handshake line')"

python3 - "$WORK" "$HOME" <<'PY' && check "config files are correct" ok || check "config files are correct" no
import json, os, sys, stat
work, home = sys.argv[1], sys.argv[2]
mcp = json.load(open(os.path.join(work, ".mcp.json")))
assert mcp["mcpServers"]["playwright"]["command"] == "npx", "sibling server was lost"
assert mcp["theme"] == "dark", "unrelated top-level key was lost"
assert mcp["mcpServers"]["relai"]["env"]["API_SECRET"].startswith("aio_"), "no agent token written"
cur = json.load(open(os.path.join(work, ".cursor", "mcp.json")))
assert cur["mcpServers"]["relai"]["env"]["AGENT_ID"].startswith("agent_"), "cursor config missing agent"
assert mcp["mcpServers"]["relai"]["env"]["API_SECRET"] != cur["mcpServers"]["relai"]["env"]["API_SECRET"], "both agents share one token"
for p in (os.path.join(work, ".mcp.json"), os.path.join(work, ".cursor", "mcp.json")):
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600, f"{p} is not 600"
print(json.dumps({"token": mcp["mcpServers"]["relai"]["env"]["API_SECRET"]}), file=open(os.path.join(home, "token.json"), "w"))
PY

TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/token.json'))['token'])" 2>/dev/null || echo "")
if [ -n "$TOKEN" ]; then
  CODE_OUT=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$API/tasks?repoId=$REPO")
  [ "$CODE_OUT" = "200" ] && check "the written token actually authenticates" ok || check "the written token actually authenticates" no "HTTP $CODE_OUT"
else
  check "the written token actually authenticates" no "no token extracted"
fi

grep -q "^\.mcp\.json$" "$WORK/.git/info/exclude" 2>/dev/null && check "repo config is git-excluded" ok || check "repo config is git-excluded" no

# Second run with .mcp.json COMMITTED. A tracked file cannot be git-excluded, so
# writing a token into it would publish the credential on the next commit.
git -C "$WORK" add -f .mcp.json >/dev/null 2>&1 || true
git -C "$WORK" -c user.email=e2e@test -c user.name=e2e commit -qm "track mcp config" >/dev/null 2>&1 || true
BEFORE=$(md5 -q "$WORK/.mcp.json" 2>/dev/null || md5sum "$WORK/.mcp.json" | cut -d" " -f1)
( cd "$WORK" && npx tsx "$ROOT/packages/cli/src/index.ts" join --api "$API" > "$SANDBOX/join2.log" 2>&1 ) &
JOIN2_PID=$!
CODE2=""
for _ in $(seq 1 30); do
  CODE2=$(grep -oE '[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}' "$SANDBOX/join2.log" 2>/dev/null | head -1 || true)
  [ -n "$CODE2" ] && break; sleep 1
done
curl -s -o /dev/null -X POST "$API/auth/device/approve" \
  -H "Authorization: Bearer $ADMIN" -H "X-Owner-Id: $OWNER" -H 'Content-Type: application/json' \
  -d "{\"userCode\":\"$CODE2\",\"repoId\":\"$REPO\",\"agents\":[{\"name\":\"claude-2\",\"workerType\":\"claude\",\"role\":\"worker\"}]}" || true
wait $JOIN2_PID 2>/dev/null || true
AFTER=$(md5 -q "$WORK/.mcp.json" 2>/dev/null || md5sum "$WORK/.mcp.json" | cut -d" " -f1)
[ "$BEFORE" = "$AFTER" ] && check "a tracked config is left untouched" ok || check "a tracked config is left untouched" no "file changed"
grep -q "Refused to write a token into a file git tracks" "$SANDBOX/join2.log" && check "join says why it refused" ok || check "join says why it refused" no "$(tail -4 "$SANDBOX/join2.log")"
if git -C "$WORK" diff --quiet; then check "no token staged for commit" ok; else check "no token staged for commit" no "$(git -C "$WORK" diff --stat | tail -1)"; fi

psql_ "delete from messages where thread_id in (select id from threads where repo_id='$REPO');
       delete from subscriptions where agent_id in (select id from agents where repo_id='$REPO');
       delete from events where repo_id='$REPO';
       delete from routing_log where task_id in (select id from tasks where repo_id='$REPO');
       delete from verification_log where task_id in (select id from tasks where repo_id='$REPO');
       delete from tasks where repo_id='$REPO';
       delete from threads where repo_id='$REPO';
       delete from tokens where agent_id in (select id from agents where repo_id='$REPO');
       delete from invites where repo_id='$REPO';
       delete from device_authorizations where repo_id='$REPO';
       delete from agents where repo_id='$REPO';
       delete from repos where id='$REPO';
       delete from users where id='$OWNER';" >/dev/null 2>&1 || echo 'WARN: teardown left rows behind'

echo ""
echo "JOIN E2E: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
