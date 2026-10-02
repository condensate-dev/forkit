# Contributing to forkit

## Clean-room rule

**forkit is original work: copy no file, type, comment or constant from any other project's private code.** Every chain fact must come from viem's chain definitions or from public docs and verified contracts. Cite the source in a comment.

## Setup

You need [bun](https://bun.sh), Node ≥ 22.18 (for the jest and node:test runners and the 4337 bundler), and foundry's `anvil`, 1.7.1 or newer. CI runs 1.7.1 and stable.

```sh
bun install
bun run build         # dist/: what npm ships; examples/* and their typecheck import it
bun run typecheck     # tsc, strict + noUncheckedIndexedAccess
bun run lint          # biome; `any` is an error (bun run format fixes formatting)
bun run test          # unit + smoke tests under bun:test, vitest, jest and node:test; no anvil
bun run test:anvil    # local anvils, no network; every runner adapter and the shared fork
bun run test:e2e      # forks real chains; replays committed recordings (FORKIT_CACHE=offline in CI)
bun run test:examples # the runnable examples, offline, against dist/
bun run test:pack     # npm pack, install in a fresh project, import under all four runners
```

The package's own tests import `src/` directly. Anything that imports `@condensate_dev/forkit` by name (the examples, users) gets the built `dist/`, so rebuild after changing `src/` before running the examples.

Before a PR, run all of them on **both** anvil versions. A fork test that passes on only one version is a bug.

## Tests that touch real chains

- **Pin every block.** On several chains, pin them at the same moment.
- **Make the test deterministic** so the offline replay serves it: keys and addresses derived from fixed strings, absolute deadlines, ERC-4337 nonce keys pinned. See [the fork cache guide](docs/guides/fork-cache-and-ci.md#making-replays-deterministic).
- **Record once with network**, then check that `FORKIT_CACHE=offline` passes on both anvil versions, then commit the recording (`.forkit-cache/…`, and `.forkit-http/…` for quote APIs).
- **Use a scoped `cacheDir`** for a new e2e, so recordings don't collide.

## Style

- Comments explain why, not what. Keep them short.
- Errors fail loudly and say what to do next.
- Public API changes need docs in `docs/` and a line in `CHANGELOG.md` under **Unreleased**.
- Commits use conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), with a body that explains the change.

## Pull requests

Keep a PR to one milestone or one fix. Fill in the PR template, and link the docs page you changed.
