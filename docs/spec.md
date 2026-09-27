# forkit: Foundry-style fork tests in TypeScript

Repo: `condensate-dev/forkit` (private). Package: `@condensate/forkit`, because the unscoped `forkit` on npm is taken.

**Clean-room rule.** forkit is original work. The build must copy no file, type, comment or constant from any other project's private code. Every chain fact comes from viem's chain definitions or from public docs.

## The pitch

Foundry gives Solidity devs `vm.createSelectFork`, `deal`, `prank`, `warp`, `snapshot`/`revertTo`, `expectRevert` and `expectEmit`. forkit gives TypeScript devs the same things against real forked chains, inside the test runner they already use: vitest, bun:test, jest or node:test. Your production TS code (routing, quoting, SDK calls) runs against real mainnet state, and you assert on what actually landed.

## Shape

| Layer | What | Depends on |
|---|---|---|
| `@condensate/forkit` (core) | `fork()`, the fork handle, cheats, snapshots and assertions. Has no test-framework imports. | viem, prool (anvil process), foundry's `anvil` on PATH |
| `@condensate/forkit/vitest` | `describeFork`, `itFork` and the fixture lifecycle | core + vitest |
| `@condensate/forkit/bun` | the same for `bun:test` | core |
| `@condensate/forkit/jest`, `/node` | the same for jest and node:test | core |
| `@condensate/forkit/4337` (optional) | boots an ERC-4337 bundler (alto) against a fork | core |

## Core API (target)

```ts
const f = await fork({ chain: base, blockNumber: 21_000_000n })   // or fork([base, arbitrum]) for multi-chain
f.client                       // viem client: test + public + wallet actions, typed
await f.deal(USDC, alice, 10_000_000n)       // ERC-20 via anvil_dealERC20, with a read-back check
await f.dealNative(alice, parseEther("1"))
await f.prank(whale, async (c) => c.sendTransaction(...))  // scoped impersonation, auto-stopped
await f.warp(seconds) / f.roll(blocks)
const id = await f.snapshot(); await f.revertTo(id)          // per-test isolation
f.on(arbitrum)                 // choose one chain in a multi-fork
await f.stop()
```

Assertions, framework-agnostic and returning rich diffs:
- `expectRevert(promise, reason | selector)`
- `expectEmit(receipt, abiEvent, args)`
- `expectBalanceChange(token, holder, delta, fn)`

## Behaviour to get right (each learned the hard way)

- **Fail loudly, never skip.** If anvil is missing, it is a collection-time error with an install hint. A fork suite that can't run is a broken environment, not a green test.
- **OP-stack chains need `--optimism`.** Detect OP-stack from the viem chain object (`contracts.gasPriceOracle` present). Pass the flag only when true: never pass `optimism: false`, because anvil parses `false` as a subcommand and refuses to start.
- **Ports.** Allocate a free port per fork, from the OS rather than at random, so parallel files and multi-chain setups never collide.
- **Readiness and teardown.** Boot has a generous timeout (fork sync against public RPCs is slow). Teardown has its own ceiling, so a wedged anvil can't hang the suite. Kill the process group.
- **deal verification.** After `anvil_dealERC20`, read `balanceOf` back. Throw a clear error for rebasing or derived-balance tokens and for anvil builds too old to have the method (tell the user to run `foundryup`).
- **RPC resolution.** Use an explicit `forkUrl`, else an env override per chain id, else the viem chain's default RPC. Recommend a paid RPC with a pinned block so runs are reproducible, and support anvil's RPC cache directory.
- **Pinned blocks.** Warn when a suite runs unpinned against a live head, because it isn't reproducible.

## Better than the original (productionization)

1. Per-test snapshot and revert as the default isolation. One fork boot per file, not per test.
2. Shared fork across files: a global setup boots it once and workers attach by URL.
3. A traces-on-failure mode: when a tx reverts, decode the call trace (`debug_traceTransaction`) against known ABIs and print it Foundry-style.
4. Gas snapshots, like `forge snapshot`: write the gas per labelled tx to a file and diff it in CI.
5. Labels: `f.label(addr, "USDC")` makes addresses readable in errors and traces.
6. CI recipe: a GitHub Action to install foundry, cache the anvil RPC cache, and matrix across runners.
7. Docs site pages: a quickstart per runner and "Foundry → forkit" cheatcode mapping table.

## Landscape to research before building (and cite in the README)

- tevm: an EVM in JS; the closest competitor, and its trade-offs.
- prool (wevm): process instances; forkit builds on it.
- viem test actions.
- Hardhat network forking.
- Foundry's own `forge test --fork-url`.

forkit's position: real anvil, your production TS code, any runner, Foundry ergonomics.

## Milestones

1. Scaffold: bun workspace, tsc, biome, CI and an MIT license (hold the license until the maintainers decide).
2. Core `fork()`, deal, prank, warp, roll and snapshot, plus a vitest adapter. E2E test: fork Base, deal USDC, and a Uniswap or 0x-style swap through public calldata.
3. Multi-chain handle, and the bun:test and jest adapters.
4. Assertions, traces-on-failure and labels.
5. Gas snapshots and a shared fork across files.
6. The 4337 bundler add-on.
7. Docs, README and landscape comparison; npm publish only when the maintainers say so.
