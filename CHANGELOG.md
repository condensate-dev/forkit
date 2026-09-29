# Changelog

All notable changes to `@condensate/forkit`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Docs** (milestone 7): the forkit book (`docs/`, table of contents in `docs/SUMMARY.md`), with getting-started pages per runner, the Foundry → forkit cheatcode reference, guides, a landscape comparison, a FAQ and troubleshooting. Runnable examples in `examples/`, plus contributor, security and GitHub templates.
- **ERC-4337 bundler** (milestone 6): `@condensate/forkit/4337`. `bundler(f)` runs Pimlico's alto against a fork, with funded executors, EntryPoints v0.6–v0.9, and bundling that survives snapshot/revert.
- **Cross-chain simulators** (milestone 5b): `@condensate/forkit/http` (quote-API record/replay pinned to the fork block, with secrets redacted) and `@condensate/forkit/bridges` (Across relayer, Relay solver, and `bridge.custom`).
- **Gas snapshots and shared forks** (milestone 5): `f.gasSnapshot(label, tx)` with `write`/`check`/`off` modes, and `startSharedForks()` / `{ shared: true }` with an exclusive lease across files.
- **Assertions, traces and labels** (milestone 4): `expectRevert`, `expectEmit`, `expectBalanceChange`, Foundry-style decoded traces on failure, `f.trace(hash)`, and `label()` / `registerAbi()`.
- **Multi-chain and every runner** (milestone 3): `fork([a, b])` with `on(chain)`, and `describeFork`/`itFork` for vitest, bun:test, jest and node:test.
- **Core** (milestone 2): `fork()`, `deal` (verified, with storage-slot fallback), `dealNative`, `prank`, `warp`, `roll`, `snapshot`/`revertTo`, the vitest adapter, and the fork state cache (record once, replay offline).
- **Scaffold** (milestone 1): the bun workspace, strict TypeScript, biome and CI on anvil 1.7.1 and stable.
