# Changelog

All notable changes to `@condensate/forkit`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Everything below is slated for **1.0.0** (`packages/forkit/package.json` carries that version). Not yet published to npm. Licensed under MIT OR Apache-2.0.

### Changed
- **condensate.dev/forkit is a Vocs docs site** (`site/`, replacing the static `site/forkit/` page). The forkit book becomes the sidebar docs (synced from `docs/` at build time), with ⌘K search, light and dark themes, and a home page in the viem/Reth pattern: the forkit lockup over Condensate's forked-vapor WebGL shader, an npm/pnpm/bun install box, feature cards, the USDC quickstart, real terminal output and explorer screenshots. It builds static under `/forkit/` (`bun run site:build` → `site/dist`), with an offline link check and 390/1440 light/dark screenshots in CI. Not deployed from this repo.
- **Ships compiled JavaScript** (release readiness): `@condensate/forkit` now builds to `dist/` (ESM, `.d.ts`, source maps), and `exports` and the `forkit` bin point there. Before this, the package exported its TypeScript sources, which works inside this workspace but not from `node_modules`: Node refuses to strip types there, so node:test and jest could not import an installed forkit. `bun run test:pack` (a CI job) packs the package, installs it into a fresh project and checks all four runners, every subpath, a strict `nodenext` TypeScript consumer and the `forkit` bin.

### Added
- **Explorer UI v2** (`forkit explore`): rebuilt in the Condensate design language (the orb and a "forkit explore" wordmark, neutral surfaces, seam violet used sparingly, light and dark, WCAG AA contrast, a phone layout) and made for reading a test run. The run overview puts failures first with expected vs actual. A test's timeline shows every transaction and cheatcode in order. The transaction view has a collapsible decoded call tree with events inline and a frame inspector, a gas icicle, token transfers as a flow, balances and storage before and after, and "Copy as code" (a forkit test that replays the steps, or a viem call). Addresses get a balance chart over the run. Search, `j`/`k`/`h`/`l`/`/` keys, deep links for every view and selection, and virtualised lists for large runs. Still offline, static and CSP-safe.
- **Run records carry more:** cheatcodes (`prank`, `warp`, `roll`, `snapshot`, `revertTo`, as a new `cheat` run event), each trace frame's own events, a per-transaction state diff with named storage slots, and a failed test's expected and actual values.
- **condensate.dev/forkit page** (milestone 10): a static page in `site/forkit/` (no framework, relative URLs, works under `/forkit/`), with a screenshot test under the subpath and `site/tools/build-assets.ts` to regenerate its explorer screenshots and terminal output. Not deployed from this repo.
- **Post-test explorer** (milestone 9): `FORKIT_RECORD=1` writes a run record per test run (`.forkit/runs/<id>.json`: forks, transactions with decoded calls, traces and logs, balance changes, bridge fills, HTTP replays, gas snapshots), and `forkit explore [run]` serves a local, offline web UI over it. A `deal` run event for reporters and records.
- **Terminal output** (milestone 8): `@condensate/forkit/reporter`. Boot lines, per-test transactions, gas and signed balance changes, bridge fills, decoded failure traces with expected vs actual, and a gas snapshot diff; a vitest reporter, a bun preload, and `formatRun()` for jest and node:test. Honours `NO_COLOR`, `FORCE_COLOR`, TTY and CI.
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
