#!/bin/bash
# relai standalone MCP — installer.
#
# Exists because the manual path is four values plus an absolute path hand-copied
# into JSON, and the README had to warn about three separate ways to get that
# wrong (tilde not expanding, a trailing comma failing silently, a relative path).
# All three are avoidable: this computes the path, merges the JSON, and backs up
# whatever it touches.
#
# Written for macOS /bin/bash, which is 3.2 — no associative arrays, no `readarray`,
# and `timeout` does not exist. Keep it that way.
#
#   ./install.sh              detect the client, install, verify
#   ./install.sh --desktop    force Claude Desktop
#   ./install.sh --code       force Claude Code (~/.claude.json)
#   ./install.sh --check      connectivity and prerequisites only, change nothing

set -u

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/relai-mcp"
MODE=""
CHECK_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --desktop) MODE="desktop" ;;
    --code)    MODE="code" ;;
    --check)   CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }
warn() { printf '  note  %s\n' "$*"; }

fail=0

say "relai MCP installer"
say ""

# ---- credentials -----------------------------------------------------------
# Shipped alongside as credentials.env when the sender personalised this package.
if [ -f "$SRC/credentials.env" ]; then
  # shellcheck disable=SC1091
  . "$SRC/credentials.env"
  ok "credentials.env found"
else
  bad "credentials.env is missing — ask the sender for the personalised package"
  exit 1
fi

for v in API_URL AGENT_ID REPO_ID API_SECRET; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then bad "$v is empty in credentials.env"; fail=1; fi
done
[ "$fail" -eq 1 ] && exit 1

# ---- prerequisites ---------------------------------------------------------
say ""
say "Checking prerequisites"

if ! command -v node >/dev/null 2>&1; then
  bad "node is not installed — get the LTS build from https://nodejs.org"
  fail=1
else
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -lt 18 ]; then
    bad "node $(node --version) is too old; 18 or newer is required"
    fail=1
  else
    ok "node $(node --version)"
  fi
fi

# ---- connectivity ----------------------------------------------------------
# Split deliberately: /livez needs no token, so it separates "can I reach the
# machine" from "is my token right". Conflating those wastes an afternoon.
say ""
say "Checking the server"

livez=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API_URL/livez" 2>/dev/null)
[ -z "$livez" ] && livez=000
if [ "$livez" = "200" ]; then
  ok "reachable ($API_URL)"
else
  bad "cannot reach $API_URL (/livez returned $livez)"
  if [ "$livez" = "000" ]; then
    warn "no response at all. If this is a Tailscale address, are you connected?"
    warn "Nothing below will work until this passes. Send the sender this output."
  fi
  fail=1
fi

if [ "$livez" = "200" ]; then
  case "$API_SECRET" in
    *[![:print:]]*) bad "API_SECRET in credentials.env contains a control character — refusing"; exit 1 ;;
  esac
  # -K from a process substitution: curl's own -H would put the token in ps,
  # world-readable, for the full --max-time against a slow server.
  authcfg() { printf 'header = "Authorization: Bearer %s"\n' "$API_SECRET"; }
  auth=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -K <(authcfg) "$API_URL/health" 2>/dev/null)
  [ -z "$auth" ] && auth=000
  case "$auth" in
    200) ok "token accepted" ;;
    401) bad "token rejected — ask the sender for a fresh one"; fail=1 ;;
    *)   bad "unexpected response from /health: $auth"; fail=1 ;;
  esac
fi

if [ "$fail" -eq 1 ]; then
  say ""
  say "Stopped. Nothing was changed."
  exit 1
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  say ""
  say "All checks passed. Re-run without --check to install."
  exit 0
fi

# ---- place the server ------------------------------------------------------
say ""
say "Installing"

if [ "$SRC" != "$DEST" ]; then
  mkdir -p "$DEST"
  cp -R "$SRC/bin" "$DEST/" 2>/dev/null
  for f in README.md BUILD.txt package.json; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DEST/$f"
  done
  # Copied through a 0600-created fd rather than cp+chmod: cp preserves the
  # source's mode, so the copy would briefly hold a live token world-readable.
  if [ -f "$SRC/credentials.env" ]; then
    (umask 077 && cp "$SRC/credentials.env" "$DEST/credentials.env")
  fi
  ok "server placed at $DEST"
else
  ok "already running from $DEST"
fi
chmod 600 "$DEST/credentials.env" 2>/dev/null

SERVER="$DEST/bin/server.cjs"
[ -f "$SERVER" ] || { bad "$SERVER missing — the archive did not unpack fully"; exit 1; }

# ---- pick the client -------------------------------------------------------
DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
[ "$(uname)" != "Darwin" ] && DESKTOP_CFG="$APPDATA/Claude/claude_desktop_config.json"
CODE_CFG="$HOME/.claude.json"

if [ -z "$MODE" ]; then
  have_desktop=0; have_code=0
  [ -d "$(dirname "$DESKTOP_CFG")" ] && have_desktop=1
  command -v claude >/dev/null 2>&1 && have_code=1
  [ -f "$CODE_CFG" ] && have_code=1
  if [ "$have_desktop" -eq 1 ] && [ "$have_code" -eq 1 ]; then
    say ""
    say "Both Claude Desktop and Claude Code are present. Which should relai be added to?"
    say "  1) Claude Desktop (the chat app)"
    say "  2) Claude Code"
    printf 'Enter 1 or 2: '
    read -r choice
    case "$choice" in
      1) MODE="desktop" ;;
      2) MODE="code" ;;
      *) bad "not a valid choice"; exit 2 ;;
    esac
  elif [ "$have_desktop" -eq 1 ]; then MODE="desktop"
  elif [ "$have_code" -eq 1 ];    then MODE="code"
  else
    bad "found neither Claude Desktop nor Claude Code"
    warn "install one, or re-run with --desktop or --code to write the config anyway"
    exit 1
  fi
fi

if [ "$MODE" = "desktop" ]; then TARGET="$DESKTOP_CFG"; LABEL="Claude Desktop"; else TARGET="$CODE_CFG"; LABEL="Claude Code"; fi

# ---- merge the config ------------------------------------------------------
# Merge, never overwrite: this file may hold other MCP servers, and for Claude
# Code it holds unrelated state too. Backed up before writing either way.
mkdir -p "$(dirname "$TARGET")"
API_URL="$API_URL" AGENT_ID="$AGENT_ID" REPO_ID="$REPO_ID" API_SECRET="$API_SECRET" \
SERVER="$SERVER" TARGET="$TARGET" python3 - <<'PY'
import json, os, shutil, sys

target = os.environ["TARGET"]
entry = {
    "command": "node",
    "args": [os.environ["SERVER"]],
    "env": {
        "API_URL": os.environ["API_URL"],
        "AGENT_ID": os.environ["AGENT_ID"],
        "REPO_ID": os.environ["REPO_ID"],
        "API_SECRET": os.environ["API_SECRET"],
        # Without this the server assumes a clone of the code repo is present and exits.
        "RELAI_SKIP_REPO_CHECK": "1",
    },
}

cfg = {}
if os.path.exists(target):
    # Create at 0600 directly rather than copy2()+chmod: copy2 preserves the
    # SOURCE's mode, so a world-readable original config left the backup
    # world-readable (holding a live token) for the window before the chmod.
    bak = target + ".bak-relai"
    fd = os.open(bak, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with open(target, "rb") as src, os.fdopen(fd, "wb") as dst:
        shutil.copyfileobj(src, dst)
    try:
        with open(target) as f:
            cfg = json.load(f)
    except Exception as e:
        print(f"  FAIL  {target} is not valid JSON ({e}). Backed up to {target}.bak-relai; fix it and re-run.")
        sys.exit(1)
    print(f"  ok    backed up existing config to {os.path.basename(target)}.bak-relai (chmod 600 — it holds the old token)")

servers = cfg.setdefault("mcpServers", {})
replaced = "relai" in servers
servers["relai"] = entry

with open(target, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
os.chmod(target, 0o600)

print(f"  ok    {'replaced' if replaced else 'added'} the relai entry")
print(f"  ok    kept {len(servers) - 1} other MCP server(s)" if len(servers) > 1 else "  ok    relai is the only MCP server configured")
PY
[ $? -ne 0 ] && exit 1

say ""
say "Done. relai is configured for $LABEL."
say ""
say "One thing to know: your token is now stored in plain text in"
say "  $TARGET"
say "and in $DEST/credentials.env, plus any .bak-relai backup noted above."
say "All are chmod 600, so only you can read them."
say "Do not commit either file, paste it into a chat, or forward it to anyone,"
say "including back to whoever sent you this package."
say ""
say "Next:"
if [ "$MODE" = "desktop" ]; then
  say "  1. Quit Claude Desktop completely and reopen it. Reloading the window is not enough."
else
  say "  1. Start a new Claude Code session."
fi
say "  2. Ask it: \"list the relai tools you have\". You should see a couple of dozen,"
say "     including publish_artifact, send_message, get_thread_messages and list_agents."
say "  3. Then: \"use relai list_agents to show me who I can message\"."
say ""
say "If no relai tools appear, re-run: ./install.sh --check"
