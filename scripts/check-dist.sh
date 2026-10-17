#!/usr/bin/env bash
# packages/forkit/dist is committed, so `pnpm add github:condensate-dev/forkit#<sha>&path:/packages/forkit`
# installs a working package with no build step (pnpm refuses a git dependency's build scripts
# unless every consumer allowlists them). This fails when the committed dist/ is not what
# `bun run build` makes from src/: rebuild and commit it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../packages/forkit"
bun run build >/dev/null
if ! git diff --quiet -- dist || [ -n "$(git status --porcelain --untracked-files=all -- dist)" ]; then
  echo "check-dist: packages/forkit/dist is stale. Run \`bun run build\` and commit dist/:" >&2
  git status --short --untracked-files=all -- dist | head -40 >&2
  exit 1
fi
echo "check-dist: packages/forkit/dist matches src/"
