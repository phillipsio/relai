#!/usr/bin/env bash
# PreToolUse(Bash) gate: block `git push` until the multi-persona review panel
# (/pr-review) has approved the current HEAD commit.
#
# Pass receipt: <repo>/.git/pr-review-pass contains the HEAD sha that the panel
# approved (verdict != REQUEST CHANGES). The /pr-review skill writes it.
#
# Bypass (intentional): set RELAI_SKIP_REVIEW=1 on the push, or use --no-verify.
#
# Exit 0 = allow the tool call. Exit 2 = block, stderr is fed back to Claude.

input=$(cat)

# Fast path: if the raw payload has no "git push", this isn't our concern.
case "$input" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

# Parse the actual command out of the tool input.
cmd=$(printf '%s' "$input" | /usr/bin/python3 -c 'import sys,json
try:
    print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception:
    print("")' 2>/dev/null)

# Only gate real `git push` invocations.
printf '%s' "$cmd" | grep -Eq '(^|[;&|]|[[:space:]])git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*push' || exit 0

# Intentional bypass.
if [ "${RELAI_SKIP_REVIEW:-}" = "1" ] || printf '%s' "$cmd" | grep -q -- '--no-verify'; then
  exit 0
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
head=$(git -C "$root" rev-parse HEAD 2>/dev/null) || exit 0
marker="$root/.git/pr-review-pass"

if [ -f "$marker" ] && [ "$(cat "$marker" 2>/dev/null)" = "$head" ]; then
  exit 0
fi

cat >&2 <<EOF
Push blocked by pre-push review gate.

The multi-persona review panel has not approved HEAD ($head).
Run /pr-review on this branch first:
  - verdict APPROVE / APPROVE WITH NITS -> a pass receipt is written and the push proceeds
  - verdict REQUEST CHANGES -> address the blockers, then re-run

To override intentionally, push with RELAI_SKIP_REVIEW=1 or --no-verify.
EOF
exit 2
