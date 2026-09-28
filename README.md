# forkit

Foundry-style fork tests in TypeScript, for any test runner.

Fork real chains with anvil, fund accounts, impersonate, warp time, snapshot and revert, and assert on what actually landed. It runs inside vitest, bun:test, jest or node:test.

## Status

Pre-alpha. The design is in [docs/spec.md](docs/spec.md); work lands milestone by milestone (spec, "Milestones").

- [x] **1. Scaffold**: bun workspace, strict TypeScript, biome, CI, and the public API as typed stubs that throw `NotImplementedError`.
- [ ] 2. Core `fork()`, deal, prank, warp, roll, snapshot, and the vitest adapter.
- [ ] 3. Multi-chain handle, bun:test and jest adapters.
- [ ] 4. Assertions, traces-on-failure, labels.
- [ ] 5. Gas snapshots, shared fork across files.
- [ ] 5b. Simulated cross-chain providers: HTTP quote record/replay, Across and Relay relayer simulators.
- [ ] 6. ERC-4337 bundler add-on.
- [ ] 7. Docs, landscape comparison, npm publish.

The package is `"private": true` and unpublished until the maintainers say otherwise.

TODO(license): no license yet. MIT is planned; the maintainers decide before anything is published.

## Layout

```
packages/
  forkit/        @condensate/forkit: core; runner adapters land as subpath exports
                 (/vitest, /bun, /jest, /node)
```

Add-ons with their own dependencies (the 4337 bundler, the milestone 5b bridge simulators and HTTP
record/replay) get their own workspace package under `packages/` when they are built.

## Development

Needs [bun](https://bun.sh), Node >= 22.18 (for the node:test and jest smoke tests), and, from
milestone 2, [foundry](https://getfoundry.sh)'s `anvil` on `PATH`.

```sh
bun install
bun run typecheck   # tsc, strict + noUncheckedIndexedAccess
bun run lint        # biome lint + format check; `any` is an error
bun run test        # smoke tests under bun:test, vitest, jest and node:test
bun run format      # apply biome fixes
```
