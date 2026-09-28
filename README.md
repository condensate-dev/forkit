# forkit

Foundry-style fork tests in TypeScript, for any test runner.

Fork real chains with anvil, fund accounts, impersonate, warp time, snapshot and revert, and assert on what actually landed. It runs inside vitest, bun:test, jest or node:test.

## Status

Pre-alpha. The design is in [docs/spec.md](docs/spec.md); work lands milestone by milestone (spec, "Milestones").

- [x] **1. Scaffold**: bun workspace, strict TypeScript, biome, CI, and the public API as typed stubs that throw `NotImplementedError`.
- [x] **2. Core**: `fork()`, deal, prank, warp, roll, snapshot, the vitest adapter, and the fork state cache (record once, replay offline).
- [ ] 3. Multi-chain handle, bun:test and jest adapters.
- [ ] 4. Assertions, traces-on-failure, labels.
- [ ] 5. Gas snapshots, shared fork across files.
- [ ] 5b. Simulated cross-chain providers: HTTP quote record/replay, Across and Relay relayer simulators.
- [ ] 6. ERC-4337 bundler add-on.
- [ ] 7. Docs, landscape comparison, npm publish.

The package is `"private": true` and unpublished until the maintainers say otherwise.

TODO(license): no license yet. MIT is planned; the maintainers decide before anything is published.

## Quickstart (vitest)

```ts
import { parseEther } from "viem";
import { base } from "viem/chains";
import { describeFork, itFork } from "@condensate/forkit/vitest";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const alice = "0x1111111111111111111111111111111111111111";

describeFork("my route", { chain: base, blockNumber: 51_800_000n }, (f) => {
  itFork("pays out", async () => {
    await f.dealNative(alice, parseEther("1"));
    await f.deal(USDC, alice, 1_000_000_000n); // exact, verified by reading balanceOf back
    await f.prank(alice, async (c) => {
      // c is a viem client whose account is alice: impersonated, no key needed
    });
    await f.warp(3_600); // seconds, then mines a block
    await f.roll(10); // blocks
  });
  // One anvil per describeFork; every itFork starts from the same snapshot.
});
```

To use the core without a runner, call `const f = await fork({ chain: base, blockNumber })`. The handle gives you:

- `f.client`: viem test, public and wallet actions;
- `deal` and `dealNative`;
- `prank`;
- `warp` and `roll`;
- `snapshot` and `revertTo`;
- `stop`.

anvil must be on `PATH`. If it is missing, test collection fails with an install hint instead of skipping.

`deal` tries `anvil_dealERC20` first. If that fails, it finds the balance slot itself: it probes the slots that `balanceOf` reads (from an access list), then common mapping layouts. Either way it reads `balanceOf` back to confirm the write. Tokens whose balances are derived or rebasing get a clear error.

forkit picks the RPC for each fork in this order: `forkUrl`, then `FORKIT_RPC_URL_<chainId>` (e.g. `FORKIT_RPC_URL_8453`), then the viem chain's default RPC. OP-stack chains get anvil's `--optimism` flag automatically.

## Fast, deterministic runs: the fork cache

anvil forks lazily. Each account and storage slot a test touches is fetched from the RPC the first time, which is slow and rate limited on a public RPC. At a **pinned** block those answers never change, so forkit puts a small recording proxy between anvil and the RPC:

- The first run records every answer to `.forkit-cache/<chainId>/<block>.json`.
- Later runs replay it from disk with **zero network calls**. In this repo's Base swap e2e, deal and swap take about 2.5s each cold and under 0.5s warm, and the whole file replays in about 4s with no RPC.
- `f.cacheStats()` reports hits and misses per method, and `FORKIT_DEBUG=1` logs every miss.

| `FORKIT_CACHE` / `cache:` | behaviour |
|---|---|
| `readwrite` (default) | replay hits, fetch and record misses |
| `readonly` | replay hits, fetch misses, never write |
| `offline` | replay hits, fail misses loudly, no network (CI) |
| `off` | no proxy: anvil talks to the RPC directly |

Unpinned forks are never cached, and they warn because they are not reproducible. The recording is plain JSON with sorted keys, so you have three options:

- **Commit it.** CI then runs fork tests offline with no RPC key. This repo does that for its e2e (`FORKIT_CACHE=offline` in CI).
- **Cache it in CI:**

  ```yaml
  - uses: actions/cache@v4
    with:
      path: "**/.forkit-cache"
      key: forkit-${{ hashFiles('**/*.fork.test.ts') }}
      restore-keys: forkit-
  ```

- **Let turbo cache the test task.** A pinned, replayed fork test is a pure function of its inputs, so turbo can cache it safely. List the recording as an input; re-recording changes the hash and reruns the tests.

  ```json
  {
    "tasks": {
      "test:fork": {
        "inputs": ["src/**", "test/**", ".forkit-cache/**"],
        "env": ["FORKIT_CACHE"],
        "outputs": [".forkit-cache/**"]
      }
    }
  }
  ```

After changing a pinned block, or adding a test that touches new state, re-record by running once with network access and `FORKIT_CACHE=readwrite` (the default).

## Layout

```
packages/
  forkit/        @condensate/forkit: core; runner adapters are subpath exports
                 (/vitest now; /bun, /jest, /node next)
```

Add-ons with their own dependencies get their own workspace package under `packages/` when they are built. That covers the 4337 bundler, the milestone 5b bridge simulators and the HTTP quote record/replay.

## Development

You need [bun](https://bun.sh), Node >= 22.18 (for the node:test and jest smoke tests), and [foundry](https://getfoundry.sh)'s `anvil` (1.7.1 or newer; CI runs 1.7.1 and stable) on `PATH` for the anvil and e2e suites.

```sh
bun install
bun run typecheck   # tsc, strict + noUncheckedIndexedAccess
bun run lint        # biome lint + format check; `any` is an error
bun run test        # no anvil: unit + smoke tests under bun:test, vitest, jest and node:test
bun run test:anvil  # needs anvil: forks a local anvil, no network
bun run test:e2e    # needs anvil: forks Base (replays .forkit-cache; FORKIT_CACHE=off for live)
bun run format      # apply biome fixes
```
