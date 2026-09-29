<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo/lockup.svg">
    <img alt="forkit" src="assets/logo/lockup.svg" width="360">
  </picture>
</p>

<p align="center"><strong>Foundry-style fork tests in TypeScript, for any test runner.</strong></p>

<p align="center">
  <a href="https://github.com/condensate-dev/forkit/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/condensate-dev/forkit/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="license: TBD" src="https://img.shields.io/badge/license-TBD-lightgrey">
  <img alt="runners: vitest | bun:test | jest | node:test" src="https://img.shields.io/badge/runners-vitest%20%7C%20bun%3Atest%20%7C%20jest%20%7C%20node%3Atest-blue">
  <img alt="anvil: 1.7.1+" src="https://img.shields.io/badge/anvil-1.7.1%2B-orange">
</p>

With forkit you fork real chains with anvil, fund any account, impersonate, warp time, snapshot and revert, then assert on what actually landed. Your production TypeScript (routers, quoting, SDK calls, bundlers, bridges) runs against real mainnet state, inside the runner you already use.

**[Read the forkit book →](docs/README.md)**

## Install

```sh
bun add -d @condensate/forkit viem        # or npm / pnpm / yarn
curl -L https://foundry.paradigm.xyz | bash && foundryup   # anvil 1.7.1+
```

> `@condensate/forkit` isn't published to npm yet. Until it is, use it from this repository.

## Quickstart

```ts
import { erc20Abi, parseUnits } from "viem";
import { base } from "viem/chains";
import { describeFork, itFork } from "@condensate/forkit/vitest";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const alice = "0x1111111111111111111111111111111111111111";
const bob = "0x2222222222222222222222222222222222222222";

describeFork("payouts on Base", { chain: base, blockNumber: 51_800_000n }, (f) => {
  itFork("alice pays bob 25 USDC", async () => {
    f.label(USDC, "USDC");
    await f.deal(USDC, alice, parseUnits("100", 6));             // exact, verified by balanceOf
    await f.expectBalanceChange(USDC, bob, parseUnits("25", 6), () =>
      f.prank(alice, (c) =>                                       // impersonated: no key needed
        c.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [bob, parseUnits("25", 6)] }),
      ),
    );
  });
  // One anvil per describeFork. Every itFork starts from the same snapshot.
});
```

The same `describeFork` / `itFork` pair ships for [vitest](docs/getting-started/vitest.md), [bun:test](docs/getting-started/bun.md), [jest](docs/getting-started/jest.md) and [node:test](docs/getting-started/node.md).

## Features

- **Foundry ergonomics**: `deal`, `prank`, `warp`, `roll`, `snapshot`/`revertTo` and `label`. The [cheatcode reference](docs/reference/cheatcodes.md) maps every cheatcode.
- **Any runner**: vitest, bun:test, jest (native ESM) and node:test, with per-test snapshot isolation and nested `describe` support.
- **Assertions and traces**: `expectRevert` (reasons, selectors, custom errors), `expectEmit` and `expectBalanceChange`. A reverted write carries a decoded, Foundry-style call trace. See the [guide](docs/guides/assertions-and-traces.md).
- **Terminal output**: `@condensate/forkit/reporter` prints each fork's boot line, a per-test table of transactions, gas and signed balance changes, bridge fills and a gas snapshot diff; `NO_COLOR`, TTY and CI aware. See the [guide](docs/guides/terminal-output.md).
- **Post-test explorer**: `FORKIT_RECORD=1` records each run, and `forkit explore` serves a local, offline web UI with every test's transactions, decoded calls and traces, events and balance changes. See the [guide](docs/guides/explore.md).
- **Record once, replay offline**: the fork cache records every RPC answer at a pinned block, so CI runs fork tests with no network and no RPC key. See the [guide](docs/guides/fork-cache-and-ci.md).
- **Multi-chain**: `fork([base, arbitrum])` boots the chains in parallel, and `f.on(chain)` selects one. See the [guide](docs/guides/multi-chain.md).
- **Cross-chain routes**: Across and Relay relayer simulators and `bridge.custom`, plus quote-API record/replay pinned to the fork block. See the [guide](docs/guides/cross-chain.md).
- **ERC-4337**: `bundler(f)` runs alto against the fork, so user operations from real smart accounts land. See the [guide](docs/guides/erc-4337.md).
- **Gas snapshots and shared forks**: `forge snapshot`-style gas files checked in CI, and one fork shared by every file. See [gas snapshots](docs/guides/gas-snapshots.md) and [shared forks](docs/guides/shared-forks.md).

## Examples

| Example | Runner | Shows |
|---|---|---|
| [vitest-swap](examples/vitest-swap) | vitest | fork Base, deal USDC, swap through a real DEX, assert balance changes and gas |
| [bun-multichain](examples/bun-multichain) | bun:test | two chains in one suite, `f.on(chain)`, isolation across both |
| [jest-bridge](examples/jest-bridge) | jest | a cross-chain route through the Across simulator, with fee accounting |

Each example runs offline from its committed recording.

## Why forkit

- **Real anvil**, the node Foundry users trust, not an EVM re-implementation.
- **Your production TypeScript**, not a parallel Solidity test suite.
- **Any runner**, with Foundry's ergonomics.

The [landscape page](docs/landscape.md) compares forkit with tevm, anvil plus viem by hand, Hardhat's network helpers and Foundry itself, including when each one is the better choice.

## Project

- [The forkit book](docs/README.md) · [Table of contents](docs/SUMMARY.md) · [FAQ](docs/faq.md) · [Troubleshooting](docs/troubleshooting.md)
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Design spec](docs/spec.md)

`@condensate/forkit` is private and unpublished until the maintainers decide. TODO(license): no license yet. MIT is planned, and the maintainers decide before anything is published.
