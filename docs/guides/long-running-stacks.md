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
