#!/usr/bin/env bash
# `relai join` end to end. Lives in packages/cli/scripts because it is the CLI's
# test; this wrapper is what run-shell-tests.sh discovers.
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/packages/cli/scripts/test-join-e2e.sh"
