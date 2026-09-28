# forkit

Foundry-style fork tests in TypeScript, for any test runner.

Fork real chains with anvil, fund accounts, impersonate, warp time, snapshot and revert, and assert on what actually landed. It runs inside vitest, bun:test, jest or node:test.

## Status

Pre-alpha. The design is in [docs/spec.md](docs/spec.md); work lands milestone by milestone (spec, "Milestones").

- [x] **1. Scaffold**: bun workspace, strict TypeScript, biome, CI, and the public API as typed stubs that throw `NotImplementedError`.
- [x] **2. Core**: `fork()`, deal, prank, warp, roll, snapshot, the vitest adapter, and the fork state cache (record once, replay offline).
- [x] **3. Multi-chain and every runner**: `fork([base, arbitrum])` with `on(chain)`, and `describeFork` / `itFork` for bun:test, jest and node:test as well as vitest.
- [x] **4. Assertions, traces, labels**: `expectRevert`, `expectEmit`, `expectBalanceChange`; reverted writes carry a decoded, Foundry-style call trace; `label(address, name)`.
- [x] **5. Gas snapshots and a shared fork**: `f.gasSnapshot(label, tx)` writes or checks a `.gas-snapshot` file, like `forge snapshot`; `startSharedForks()` in a global setup boots one fork that every file attaches to.
- [x] **5b. Simulated cross-chain providers**: `@condensate/forkit/http` records quote APIs and replays them pinned to the fork block; `@condensate/forkit/bridges` has Across and Relay relayer simulators plus `bridge.custom`; the Base → Arbitrum e2e runs offline.
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

The same `describeFork` / `itFork` pair comes in one adapter per runner, all with the same behaviour:

| Runner | Import |
|---|---|
| vitest | `@condensate/forkit/vitest` |
| bun:test | `@condensate/forkit/bun` |
| jest (native ESM) | `@condensate/forkit/jest` |
| node:test | `@condensate/forkit/node` |

For any other runner, `createForkAdapter({ describe, it, hooks })` builds the pair from its `describe`, `it` and lifecycle hooks.

To use the core without a runner, call `const f = await fork({ chain: base, blockNumber })`. The handle gives you:

- `f.client`: viem test, public and wallet actions;
- `deal` and `dealNative`;
- `prank`;
- `warp` and `roll`;
- `snapshot` and `revertTo`;
- `stop`.

### Multi-chain

Pass several chains to fork them side by side, one anvil each, booted in parallel:

```ts
import { arbitrum, base } from "viem/chains";

const f = await fork([
  { chain: base, blockNumber: 51_800_000n },
  { chain: arbitrum, blockNumber: 380_000_000n },
]);
f.chain;                         // base: the first chain is selected
const arb = f.on(arbitrum);      // arbitrum's handle; arb.on(base) === f
f.forks;                         // [baseHandle, arbHandle], in the order given
await f.stop();                  // stops both, from either handle
```

Every method (`client`, `deal`, `snapshot`, ...) acts on the selected chain. If one chain fails to boot, the others are stopped before the error is thrown. `describeFork` takes the same array, and its per-test isolation snapshots and reverts every chain. Inside a `describeFork` body, `f.on(chain)` works at collection time too: it returns a handle that resolves once the fork is up.

### Assertions

Framework-agnostic: they throw `ForkitAssertionError` (with `actual` and `expected`, so vitest prints a diff) and return what they matched.

```ts
import { expectBalanceChange, expectEmit, expectRevert, NATIVE } from "@condensate/forkit";

await expectRevert(f.client.writeContract({ ...vault, functionName: "deposit", value: 0n }), "Vault: zero deposit");
await expectRevert(write, "InsufficientBalance(address,uint256,uint256)");         // signature → selector
await expectRevert(write, { abi: vaultAbi, errorName: "InsufficientBalance", args: [alice, 0n, 1n] });
await expectRevert(read, /division or modulo by zero/);                             // panics too

expectEmit(receipt, depositedEvent, { account: alice });                            // partial args match
await f.expectBalanceChange(USDC, bob, 500_000n, () => pay(bob));                 // or NATIVE; negative for a decrease
```

A mismatch reads like `expected Error("Vault: zero deposit"), got InsufficientBalance(alice (0x0000…11cE), 0, 1)`, followed by the trace.

### Traces on failure

When `sendTransaction`, `writeContract` or `deployContract` on a fork client reverts, forkit replays the call with `debug_traceCall` and appends the decoded call tree to the error (also available as `traceOf(error)`):

```
[29461] Vault::audit(5)
  ├─ [2810] Ledger::check(5) [staticcall]
  │   └─ ← [Revert] Error("Ledger: not enough entries")
  └─ ← [Revert] Error("Ledger: not enough entries")
```

`f.trace(hash)` renders any mined transaction the same way. Calls, return values, custom errors and events decode against known ABIs: ERC-20, every ABI passed to `writeContract` / `deployContract` / `expectRevert`, and anything you `registerAbi(abi)`. Turn traces off with `traces: "off"` or `FORKIT_TRACES=off`.

### Labels

`label(address, "USDC")` (or `f.label`) names an address in every error and trace, like Foundry's `vm.label`. Labels are process-wide.

### Gas snapshots

Like `forge snapshot`: label a transaction, and forkit records its gas in `.gas-snapshot` (one `label (gas: N)` line each, sorted, meant to be committed).

```ts
await f.gasSnapshot("deposit", () => vault.write.deposit({ value: 1n })); // a function, hash, promise or receipt
```

- Locally (`write`, the default), measurements update the file. Parallel workers merge their entries under a lock.
- In CI (`check`, the default when `CI` is set), a missing entry or a changed value fails the test: `gas for "deposit" changed: 51234 → 53012, +1778 (+3.47%)`.
- `off` just returns the gas.

Set the mode with `gasSnapshot` in the fork options or `FORKIT_GAS_SNAPSHOT`, and the file with `gasSnapshotFile` / `FORKIT_GAS_SNAPSHOT_FILE`.

### One fork shared by every file

Booting and syncing a fork is the slow part, so boot it once in a global setup and let every file attach to it:

```ts
// vitest.global-setup.ts  (vitest.config: test.globalSetup)
import { startSharedForks } from "@condensate/forkit";
import { base } from "viem/chains";

export default async () => (await startSharedForks({ chain: base, blockNumber: 51_800_000n })).stop;
```

```ts
// any test file
describeFork("swaps", base, (f) => { /* ... */ }, { shared: true });
```

The global setup publishes the fork URLs in `FORKIT_SHARED_FORKS`, which workers started after it inherit. This works for jest's `globalSetup` too; call `stop()` in `globalTeardown`. A fork has one state, so attaching takes an exclusive lease: files running in parallel take turns. Each file reverts the fork to the state it found before handing it on, and per-test isolation still applies inside a file. `attachSharedFork(targets)` is the runner-free form. Its `stop()` releases the fork and leaves the anvil running.

### How writes behave

Unless you pass `gas`, fork-client writes estimate gas first and send with it, as a real node does. On anvil, an impersonated transaction that reverts would otherwise be mined silently, and you would only get a hash. With automine on, a write returns only once its state is visible, so the next read sees it. Pass an explicit `gas` to mine a reverting transaction on purpose; then `expectRevert(receiptPromise, …, { client: f.client })` decodes it from the trace. With automine off, the estimate runs against `latest`, so a transaction that depends on another one still pending fails at estimation; pass `gas` for it.

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

## Cross-chain routes, deterministically

Test a cross-chain route end to end on a multi-chain fork, with no live relayer and no live quote API:

```ts
import { bridge } from "@condensate/forkit/bridges";
import { http } from "@condensate/forkit/http";

const f = await fork([{ chain: base, blockNumber: B }, { chain: arbitrum, blockNumber: A }]);
const across = bridge.across(f);                  // watch Base's SpokePool from now on

// Your app's own fetch calls: recorded once, replayed in CI (pinned to the Base block).
const quote = await http.with({ name: "across/base-arb-usdc", blockNumber: B, hosts: ["app.across.to"] }, () =>
  getAcrossQuote(),
);
await depositOnBase(quote);                       // your production code
const [fill] = await across.settle();             // the simulated relayer fills on Arbitrum
fill.outputAmount; fill.details.fee;              // assert on economics
```

- **HTTP record/replay** (`@condensate/forkit/http`) intercepts `globalThis.fetch`. Fixtures are pinned to their fork block (replaying at another block warns), secrets are redacted from headers and URLs, and an unmatched request can fail or pass through. `FORKIT_HTTP=record|replay|auto|off`, with `replay` the default when `CI` is set. See [docs/http.md](docs/http.md).
- **`bridge.across(f)`** decodes the SpokePool's `FundsDeposited` event. On `settle()`, it impersonates a funded relayer (the exclusive relayer while that relayer's window is open) and calls `fillRelay` on the destination SpokePool, so the recipient's balance and any message handler land for real. See [docs/bridges-across.md](docs/bridges-across.md).
- **`bridge.relay(f)`** watches Relay's depository (`RelayNativeDeposit` / `RelayErc20Deposit`). A simulated solver pays the order registered with `b.expect(orderId, …)` or `b.expectQuote(quote)`, running any calls through Relay's router. An unknown order fails loudly. See [docs/bridges-relay.md](docs/bridges-relay.md).
- **`bridge.custom(f, { originEvent, destinationOf, onDeposit })`** covers any other bridge.

Fees are configurable, and every fill reports its fee in `details`. `test/e2e/base-arbitrum-across.vitest.ts` shows the whole loop: an Across quote replayed from a fixture, a Base USDC deposit, a fill on Arbitrum, and fee accounting that matches the quote exactly.

## Layout

```
packages/
  forkit/        @condensate/forkit: core; subpath exports for the runner adapters
                 (/vitest, /bun, /jest, /node), /http and /bridges
```

The bridge simulators (`/bridges`) and HTTP record/replay (`/http`) need nothing beyond viem, so they are subpath exports of the core package. Add-ons with their own dependencies, such as the 4337 bundler, get their own workspace package under `packages/`.

## Development

You need [bun](https://bun.sh), Node >= 22.18 (for the node:test and jest smoke tests), and [foundry](https://getfoundry.sh)'s `anvil` (1.7.1 or newer; CI runs 1.7.1 and stable) on `PATH` for the anvil and e2e suites.

```sh
bun install
bun run typecheck   # tsc, strict + noUncheckedIndexedAccess
bun run lint        # biome lint + format check; `any` is an error
bun run test        # no anvil: unit + smoke tests under bun:test, vitest, jest and node:test
bun run test:anvil  # needs anvil: forks local anvils, no network; every runner adapter, shared fork
bun run test:e2e    # needs anvil: forks Base (replays .forkit-cache; FORKIT_CACHE=off for live)
bun run format      # apply biome fixes
```
