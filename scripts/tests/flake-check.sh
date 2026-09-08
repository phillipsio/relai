#!/usr/bin/env bash
# Runs the shell suite N times and reports which assertions failed, so a flake
# rate is a committed measurement rather than a number typed from a terminal.
#
# Usage: scripts/tests/flake-check.sh [runs]   (default 30)
#
# Exit 0 only when every run passed. Any failure prints the per-assertion
# tally, because "how often" matters less than "which assertion".
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runs="${1:-30}"
log="$(mktemp -d)"
trap 'rm -rf "$log"' EXIT INT TERM

failed_runs=0
for i in $(seq 1 "$runs"); do
  if bash "$here/watcher.test.sh" >"$log/run-$i.log" 2>&1; then
    printf '.'
  else
    printf 'F'
    failed_runs=$((failed_runs + 1))
  fi
done
printf '\n'

printf '%s/%s runs failed\n' "$failed_runs" "$runs"
if [ "$failed_runs" -gt 0 ]; then
  printf '\nfailures by assertion:\n'
  grep -h '^  FAIL' "$log"/run-*.log | sort | uniq -c | sort -rn
fi

# A leaked watcher is a failure of the suite even when every assertion passed.
# Matched on argv position: a shell whose arguments merely mention the path is
# not a watcher, and `pgrep -f` would have counted it.
leaked="$(ps -Ao pid=,args= | awk '$2 ~ /(^|\/)bash$/ && $3 ~ /relai-watch\.sh$/' | wc -l | tr -d ' ')"
printf '\nrelai-watch.sh processes still live on this machine: %s\n' "$leaked"

[ "$failed_runs" -eq 0 ]
