# Multi-chain forks

Pass several chains to `fork()` (or `describeFork`) to fork them side by side. Each chain gets its own anvil, and they boot in parallel:

```ts
import { arbitrum, base } from "viem/chains";
import { fork } from "@condensate_dev/forkit";

const f = await fork([
  { chain: base, blockNumber: 51_800_000n },
  { chain: arbitrum, blockNumber: 380_000_000n },
]);
f.chain;                    // base: the first chain is selected
const arb = f.on(arbitrum); // arbitrum's handle; arb.on(base) === f
f.forks;                    // [baseHandle, arbHandle], in the order given
await f.stop();             // stops both, from either handle
```

- Every method (`client`, `deal`, `snapshot`, …) acts on the selected chain. `on(chain)` selects another, and throws for a chain the handle does not fork, naming the ones it does.
- If one chain fails to boot, the others are stopped before the error is thrown. The same chain listed twice is refused before anything boots.
- `describeFork` takes the same array. Its per-test isolation snapshots and reverts **every** chain.
- Inside a `describeFork` body, `f.on(chain)` works at collection time too. It returns a handle that resolves once the fork is up.

```ts
describeFork("route", [{ chain: base, blockNumber: B }, { chain: arbitrum, blockNumber: A }], (f) => {
  const arb = f.on(arbitrum);
  itFork("lands on both", async () => {
    await f.dealNative(alice, 1n);
    await arb.dealNative(alice, 2n);
  });
});
```

Pin every chain at the same moment (matching block timestamps) when your test crosses chains. Deadlines and quote timestamps are checked against each chain's own clock. For cross-chain routes with simulated relayers, see [Cross-chain routes](cross-chain.md).
