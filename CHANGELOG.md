# Changelog

All notable changes to `@condensate/forkit`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **condensate.dev/forkit page** (milestone 10): a static page in `site/forkit/` (no framework, relative URLs, works under `/forkit/`), with a screenshot test under the subpath and `site/tools/build-assets.ts` to regenerate its explorer screenshots and terminal output. Not deployed from this repo.
- **Post-test explorer** (milestone 9): `FORKIT_RECORD=1` writes a run record per test run (`.forkit/runs/<id>.json`: forks, transactions with decoded calls, traces and logs, balance changes, bridge fills, HTTP replays, gas snapshots), and `forkit explore [run]` serves a local, offline web UI over it. A `deal` run event for reporters and records.
- **Docs** (milestone 7): the forkit book (`docs/`, table of contents in `docs/SUMMARY.md`), with getting-started pages per runner, the Foundry → forkit cheatcode reference, guides, a landscape comparison, a FAQ and troubleshooting. Runnable examples in `examples/`, plus contributor, security and GitHub templates.
- **ERC-4337 bundler** (milestone 6): `@condensate/forkit/4337`. `bundler(f)` runs Pimlico's alto against a fork, with funded executors, EntryPoints v0.6–v0.9, and bundling that survives snapshot/revert.
- **Cross-chain simulators** (milestone 5b): `@condensate/forkit/http` (quote-API record/replay pinned to the fork block, with secrets redacted) and `@condensate/forkit/bridges` (Across relayer, Relay solver, and `bridge.custom`).
- **Gas snapshots and shared forks** (milestone 5): `f.gasSnapshot(label, tx)` with `write`/`check`/`off` modes, and `startSharedForks()` / `{ shared: true }` with an exclusive lease across files.
- **Assertions, traces and labels** (milestone 4): `expectRevert`, `expectEmit`, `expectBalanceChange`, Foundry-style decoded traces on failure, `f.trace(hash)`, and `label()` / `registerAbi()`.
- **Multi-chain and every runner** (milestone 3): `fork([a, b])` with `on(chain)`, and `describeFork`/`itFork` for vitest, bun:test, jest and node:test.
- **Core** (milestone 2): `fork()`, `deal` (verified, with storage-slot fallback), `dealNative`, `prank`, `warp`, `roll`, `snapshot`/`revertTo`, the vitest adapter, and the fork state cache (record once, replay offline).
- **Scaffold** (milestone 1): the bun workspace, strict TypeScript, biome and CI on anvil 1.7.1 and stable.

### Fixed
- **ERC-4337:** a per-test revert right after a user operation could leave it in alto's processing set, so the next test that deployed the same account failed with AA10 ("Another deployment operation for this sender is already being processed"). forkit now holds the receipt until alto reports a final status.
