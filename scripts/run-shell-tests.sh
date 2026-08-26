#!/usr/bin/env bash
# Runs every scripts/tests/*.test.sh. These cover the shell scripts in the wake
# path, which no vitest suite reaches.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rc=0
for t in "$here"/tests/*.test.sh; do
  printf '\n> %s\n' "${t##*/}"
  bash "$t" || rc=1
done
exit $rc
