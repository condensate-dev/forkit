# Quickstart: vitest

This page gets you from nothing to a passing fork test on vitest. The test forks Base at a pinned block, deals USDC, impersonates an account, and checks balances.

> forkit is not on npm yet. Until it is, depend on `packages/forkit` from a checkout of this repo, as a workspace or a `file:` dependency.

## 1. Install

```sh
npm install -D @condensate_dev/forkit viem vitest
curl -L https://foundry.paradigm.xyz | bash
foundryup
anvil --version
```

- forkit supports vitest 3 and newer.
- viem is already a dependency of forkit. Install it yourself as well, because your tests import it.
- forkit runs foundry's `anvil`, which must be on `PATH`. Use anvil 1.7.1 or newer. CI tests 1.7.1 and stable. forkit does not check the version itself.
- If anvil is missing, `describeFork` throws `AnvilNotFoundError` while vitest collects the file. The error includes the install command. The suite fails. It is never skipped.

## 2. Configure vitest

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
```

The first run of a test fetches every account and storage slot it touches from the RPC. On a public RPC that can take longer than vitest's 5 s default. Replays from the fork cache (see [Running offline in CI](#running-offline-in-ci)) take well under a second.

forkit sets the timeouts of its own hooks, so the fork boot is not cut off by `hookTimeout`:

| Hook | Timeout |
|---|---|
| boot (`beforeAll`) | `bootTimeoutMs` (default 120 000) + 5 000 ms |
| stop (`afterAll`) | `stopTimeoutMs` (default 10 000) + 5 000 ms |
| snapshot and revert (`beforeEach` / `afterEach`) | 30 000 ms |

`hookTimeout` still applies to your own hooks, for example a `beforeEach` that deals tokens.

## 3. Write a test

```ts
// test/usdc.fork.test.ts
import { type Address, erc20Abi, parseEther, parseUnits } from "viem";
import { base } from "viem/chains";
import { expect } from "vitest";
import { describeFork, itFork } from "@condensate_dev/forkit/vitest";

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
// Fresh addresses: vanity ones (0x…a11ce) often hold airdropped tokens on real chains.
const alice: Address = "0x778dd60929c5b6f928aeab807fec6986f6ea3d82";
const bob: Address = "0x4a3bcc777d2982e91fc24c678af32f7119c48883";

describeFork("USDC on Base", { chain: base, blockNumber: 51_800_000n }, (f) => {
  const usdcBalance = (holder: Address) =>
    f.client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    });

  itFork("deal sets an exact balance", async () => {
    await f.deal(USDC, alice, parseUnits("1000", 6));
    expect(await usdcBalance(alice)).toBe(parseUnits("1000", 6));
  });

  itFork("alice pays bob", async () => {
    await f.deal(USDC, alice, parseUnits("1000", 6));
    await f.dealNative(alice, parseEther("1")); // for gas

    await f.expectBalanceChange(USDC, bob, parseUnits("250", 6), () =>
      // Impersonate alice: no private key, the client's account is her address.
      f.prank(alice, (c) =>
        c.writeContract({
          address: USDC,
          abi: erc20Abi,
          functionName: "transfer",
          args: [bob, parseUnits("250", 6)],
        }),
      ),
    );
    expect(await usdcBalance(alice)).toBe(parseUnits("750", 6));
  });

  itFork("every test starts from the same snapshot", async () => {
    // The deals and the transfer above were reverted after each test.
    expect(await usdcBalance(alice)).toBe(0n);
  });
});
```

- `describeFork(name, target, body)` boots one anvil that forks Base at block 51 800 000. It boots in `beforeAll` and stops in `afterAll`. The target is a viem chain, or `ForkOptions` such as `{ chain, blockNumber, forkUrl }`.
- `f` is usable in the body, but the fork only exists while tests run. Call it inside `itFork` or a hook. `f.client` at collection time throws `the fork is not running`. `usdcBalance` is fine because it only touches `f.client` when a test calls it.
- `f.client` is a viem client with public, wallet and test actions, typed for Base.
- `f.deal(token, holder, amount)` sets an ERC-20 balance to exactly `amount` and reads `balanceOf` back to confirm it. `f.dealNative(holder, amount)` sets the native balance.
- `f.prank(account, fn)` impersonates `account` while `fn` runs. `c` is a viem client whose account is that address, so no private key is needed. Impersonation stops when `fn` settles.
- Writes on a fork client return once the transaction is mined, so the next read sees it.
- `f.expectBalanceChange(token, holder, delta, fn)` runs `fn` and throws `ForkitAssertionError` unless the balance changed by exactly `delta`. Use a negative `delta` for a decrease. Import `NATIVE` from `@condensate_dev/forkit` to check the native balance. It resolves to what `fn` resolved to.
- `itFork` also passes the fork to its callback (`async (g) => ...`). The body's `f` is precisely typed. `g` is typed `Fork<Chain>` unless you write `itFork<typeof base>(...)`.

## 4. Run it

```sh
npx vitest run test/usdc.fork.test.ts
```

The first run fetches state from Base's public RPC (`https://mainnet.base.org`, viem's default) and records it in `.forkit-cache/8453/51800000.json`. Later runs replay that file and make no network calls.

## What isolation means

- One `describeFork` boots one anvil. Every `itFork` inside it shares that anvil.
- Before each test, forkit takes an EVM snapshot of every forked chain. After the test, it reverts to it. Each test starts from the pinned block's state. Deals, pranked writes, `warp` and `roll` from one test are gone in the next.
- Tests in one fork suite must run one at a time. Do not use `describe.concurrent`, `test.concurrent` or `sequence.concurrent` for these files. Separate files are fine: each file boots its own anvil on a free port, and vitest runs files in parallel.
- Nested `describe` blocks work. `itFork` gets the fork of the nearest enclosing `describeFork`. A hook in a nested block runs after forkit's snapshot, so its writes are reverted too:

```ts
import { type Address, erc20Abi, parseUnits } from "viem";
import { base } from "viem/chains";
import { beforeEach, describe, expect } from "vitest";
import { describeFork, itFork } from "@condensate_dev/forkit/vitest";

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const alice: Address = "0x778dd60929c5b6f928aeab807fec6986f6ea3d82";

describeFork("nested", { chain: base, blockNumber: 51_800_000n }, (f) => {
  describe("with 1000 USDC dealt to alice", () => {
    // Runs after forkit's snapshot, so this deal is reverted after each test too.
    beforeEach(() => f.deal(USDC, alice, parseUnits("1000", 6)));

    itFork<typeof base>("reaches the enclosing fork", async (g) => {
      // g is the nearest enclosing describeFork's fork: the same handle as f.
      const balance = await g.client.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [alice],
      });
      expect(balance).toBe(parseUnits("1000", 6));
    });
  });
});
```

- Pass `{ isolate: false }` as the fourth argument of `describeFork` to turn off snapshot and revert. Tests then see each other's writes.

## Running offline in CI

forkit puts a recording proxy between anvil and the RPC for every pinned fork. It records each answer in `.forkit-cache/<chainId>/<block>.json` under the working directory. At a pinned block those answers never change.

Set the mode with `FORKIT_CACHE` or the `cache` fork option:

| Mode | Behaviour |
|---|---|
| `readwrite` (default) | replay hits, fetch and record misses |
| `readonly` | replay hits, fetch misses, never write |
| `offline` | replay hits, fail misses, no network |
| `off` | no proxy: anvil talks to the RPC directly |

To run in CI with no RPC:

1. Run the tests once locally with network access. This writes `.forkit-cache/`.
2. Commit `.forkit-cache/`. Do not gitignore it.
3. In CI, set `FORKIT_CACHE=offline`.

```yaml
- uses: foundry-rs/foundry-toolchain@v1
- run: npx vitest run
  env:
    FORKIT_CACHE: offline
```

In `offline` mode, a request that is not in the recording fails and names the method, its params and the cache file. The suite fails too: stopping the fork throws `ForkCacheMissError` with every request that missed, even one the code under test caught. After you change a pinned block or add a test that reads new state, record again with network access and the default `readwrite` mode.

- Run tests from the same directory locally and in CI, or set `cacheDir` / `FORKIT_CACHE_DIR`, because the cache path is relative to the working directory.
- Only pinned forks are cached. Without `blockNumber`, forkit forks the live head and warns that the run is not reproducible.
- `FORKIT_DEBUG=1` logs every cache miss. `f.cacheStats()` returns hits and misses per method.

Public RPCs are slow and rate limited. To record with a paid RPC, set `FORKIT_RPC_URL_<chainId>`:

```sh
FORKIT_RPC_URL_8453=https://base-mainnet.example.com/v2/KEY npx vitest run
```

forkit picks the RPC in this order: the `forkUrl` option, then `FORKIT_RPC_URL_<chainId>`, then the viem chain's default RPC. Error messages redact keys from the URL.

## Gotchas

- **Timeouts.** A cold test on a public RPC can exceed vitest's 5 s default. Raise `testTimeout`, or pass a per-test timeout as the third argument: `itFork(name, fn, 60_000)`. forkit's own hooks have their own timeouts (see above). If boot itself is slow, raise `bootTimeoutMs` in the fork options.
- **Fresh addresses.** Vanity addresses such as `0x…a11ce` often hold airdropped tokens on real chains, so a balance you expect to be zero may not be. Use random addresses.
- **`itFork` outside `describeFork`** throws `itFork must be called inside a describeFork body`. On vitest 5 it throws during collection; on older vitest, when the test runs.
- **Nested `describe` bodies run late.** vitest collects a nested `describe` body after the parent body returns. forkit looks up the fork when each test runs, not while bodies are collected, so a nested `itFork` still gets the right fork. You do not need to do anything.

## Next

The [book](../SUMMARY.md) covers the rest of the API: multi-chain forks with `f.on(chain)`, `expectRevert` and `expectEmit`, traces on failure, labels, `warp` and `roll`, gas snapshots, and one fork shared by every file with `startSharedForks()` in a vitest `globalSetup`.
