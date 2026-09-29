# One fork shared by every file

Booting and syncing a fork is the slow part. So boot it once in a global setup, and let every test file attach to it:

```ts
// vitest.global-setup.ts   (vitest.config: test.globalSetup)
import { startSharedForks } from "@condensate/forkit";
import { base } from "viem/chains";

export default async () => (await startSharedForks({ chain: base, blockNumber: 51_800_000n })).stop;
```

```ts
// any test file
describeFork("swaps", base, (f) => { /* … */ }, { shared: true });
```

- The global setup publishes the fork URLs in `FORKIT_SHARED_FORKS`. Workers started after it inherit that.
- jest works the same way: call `startSharedForks` in `globalSetup`, and `stop()` in `globalTeardown`.
- **Taking turns:** a fork has one state, so attaching takes an **exclusive lease**, and files running in parallel take turns. Each file reverts the fork to the state it found before handing it on, and per-test isolation still applies inside a file. The lease is re-entrant within a process, and a lease held by a dead process gets taken over.
- **Pins must match:** attaching checks the chain id, and the pinned block if you give one. A bad option throws before the lease is taken.
- **Without a runner:** `attachSharedFork(targets)` is the runner-free form. Its `stop()` releases the fork and leaves the anvil running.
