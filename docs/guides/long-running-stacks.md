# A long-running local stack

A test suite boots a fork, runs and stops it. A local stack is different: one set of anvils runs for hours, real services connect to it on fixed ports, and your own launcher starts it. forkit has a piece for each part of that, and you can take only the ones you need.

## Fixed ports and your own anvil flags

```ts
import { fork } from "@condensate_dev/forkit";
import { base } from "viem/chains";

const f = await fork({
  chain: base,
  blockNumber: 51_800_000n,
  port: 8545,
  anvil: { stepsTracing: true, gasLimit: 30_000_000n },
});
```

- **`port`** is the port of the fork's anvil on 127.0.0.1. Without it, the OS picks a free one.
- **`anvil`** passes more anvil flags, by their [prool](https://github.com/wevm/prool) names. `stepsTracing` makes `debug_traceTransaction` return struct logs. `gasLimit` sets the block gas limit. forkit's own flags win, and a `false` value is dropped, because anvil's boolean flags take no value.

## A chain with nothing to fork

```ts
const local = await fork({ chain: myChain, forkUrl: false });
```

`forkUrl: false` starts an empty chain with the chain's id, for a chain that has no RPC to fork. `blockNumber` and the fork cache do not apply to it, so a pinned block is refused.

## Cheats and a bundler on an anvil you started

```ts
import { attachFork } from "@condensate_dev/forkit";
import { bundler } from "@condensate_dev/forkit/4337";

const f = await attachFork(base, "http://127.0.0.1:8545/8453");
await f.deal(USDC, alice, 1_000_000n);
const b = await bundler(f, { entryPoints: ["0.8"] });
```

`attachFork(chain, rpcUrl)` gives the same handle as `fork()` on an anvil that something else started. It checks that the URL serves the chain. `deal`, `prank`, `trace` and `bundler(f)` work on it. `stop()` leaves the anvil running.

`deal` finds a token's balance slot from what `balanceOf` reads, so you do not keep a table of slots for each token.

## The fork cache behind your own launcher

```ts
import { startRpcCache } from "@condensate_dev/forkit";

const cache = await startRpcCache({
  upstream: process.env.BASE_RPC_URL,
  chainId: 8453,
  blockNumber: 51_800_000n,
  mode: "readwrite",
  dir: ".forkit-cache",
});
// anvil --fork-url <cache.url> --fork-block-number 51800000 --no-storage-caching --no-rate-limit
setInterval(() => cache.flush(), 60_000);
// on shutdown, after anvil stops:
await cache.close();
```

`startRpcCache` is the recording proxy that `fork()` uses, on its own. Point your anvil's fork URL at `cache.url`.

- **Pin the block.** A recording belongs to one block. The proxy does not record reads at the live head.
- **Turn anvil's own cache off** (`--no-storage-caching`), or anvil answers from its disk cache and the recording misses those reads. Add `--no-rate-limit`, because the proxy is local.
- **`flush()`** writes new entries to disk and keeps serving. `close()` also writes them. A process that is killed keeps what it recorded up to its last flush.
- **Close after anvil stops**, so anvil's last reads are in the recording. In `offline` mode, `close()` rejects with a `ForkCacheMissError` that lists each request the recording did not have.
- The modes are the ones in [the fork cache guide](fork-cache-and-ci.md). `port` is optional.

## Bridges that settle on their own

A test calls `settle()`. A stack has no test, so `bridge.run` calls it for you:

```ts
import { bridge } from "@condensate_dev/forkit/bridges";

const across = bridge.across(f, { journalDir: ".stack/fills", maxFillAttempts: 3, unforkedDestination: "deliver" });
const relay = bridge.relay(f, { journalDir: ".stack/fills", maxFillAttempts: 3 });

const stop = bridge.run([across, relay], {
  intervalMs: 500,
  onError: (error) => console.error("bridge fill failed", error),
});
// on shutdown, before the anvils stop:
await stop();
```

- **One settle at a time.** A round settles each simulator in turn. The next round starts `intervalMs` after the last one ended (default 1000), so two settles never overlap.
- **`onError` is required.** It gets the error of each settle that rejects, and the loop goes on. If `onError` throws, the loop ends and `stop()` rejects with what it threw.
- **`stop()` waits** for the settle in progress, so the anvils are not stopped under a fill. It does not wait out the pause between rounds.

## The fill journal

With `journalDir`, a simulator writes the outcome of each deposit to its own JSON file, so another process (a service, a test runner, a script) can read what was filled.

- **The name** is `<journalDir>/<bridge>-<key>.json`. The key is the id the bridge knows the deposit by: for `across`, the origin chain id and the deposit id (`across-8453-12345.json`); for `relay`, the order id; for `across-prefunded`, the order id; for `cctp`, `v1-<origin domain>-<nonce>` or `v2-<deposit id>`; for `oft`, the LayerZero guid. Characters that are not safe in a file name become `-`.
- **Atomic.** forkit writes a temporary file in the same directory and renames it into place. A reader sees the whole old file or the whole new one, never half of one. Read a file at any time.
- **The content** is a `FillJournalEntry` (exported from `@condensate_dev/forkit/bridges`). Switch on `status`:

| `status` | Fields | When |
|---|---|---|
| `filled` | `destinationChainId`, `destinationTxHashes`, `outputAmount?`, `details?` | the fill ran on the destination fork |
| `unforked` | `destinationChainId`, `destinationTxHashes: []` | the destination is not in the fork and `unforkedDestination` is `deliver` |
| `failed` | `destinationChainId?`, `error: { name, message }`, `attempts`, `retrying` | the last attempt threw |

Every entry also has `version: 1`, `bridge`, `key`, `deposit` (the origin log and its decoded args) and `updatedAt`. Bigints are decimal strings. A `failed` file with `retrying: true` is replaced when a later attempt succeeds or fails again.

## Retries

A deposit whose fill throws is retried by the next `settle()`. `maxFillAttempts` bounds that:

- **Without it** (the default, right for a test), there is no limit. The deposit stays pending, holds the deposits behind it so fills keep their order, and each `settle()` rejects.
- **With it,** the deposit is given up after its last failed attempt. It leaves `pending`, goes to `failed`, and is journaled with `retrying: false`. That same `settle()` fills the deposits behind it, then rejects with the error, which `bridge.run` passes to `onError`.

A stack wants a small limit, such as 3, so one bad deposit does not block every fill behind it for ever. A Relay deposit with no registered order, or an Across prefunded order with no registered destination, counts as a failed attempt too.

## Chains you did not fork

A stack can fork only some chains. A deposit to a chain that is not in the fork follows `unforkedDestination`:

| Value | What happens |
|---|---|
| `reject` (default) | the fill fails with `destination chain N is not in this fork`, under the rule of `maxFillAttempts` |
| `skip` | the simulator drops the deposit: no fill, no journal file |
| `deliver` | the simulator records a fill with no transaction (`fill.unforked === true`) and journals it as `unforked` |

## A bundler on a long-running fork

Pass `receiptLookupBlocks` to `bundler(f)`, so a receipt lookup stays on the fork. See [the ERC-4337 guide](erc-4337.md#a-long-running-fork).
