#!/usr/bin/env bash
# Run a command with FORKIT_SURFPOOL_BIN pointing at the pinned surfpool (installing it first if
# needed), unless the caller already set it.  e.g. scripts/with-surfpool.sh vitest run --project svm
set -euo pipefail
if [ -z "${FORKIT_SURFPOOL_BIN:-}" ]; then
  FORKIT_SURFPOOL_BIN="$("$(dirname "${BASH_SOURCE[0]}")/install-surfpool.sh")"
  export FORKIT_SURFPOOL_BIN
fi
exec "$@"
