# FAQ

**Why real anvil, and not an EVM in JavaScript?**
Fidelity. anvil is the node Foundry users already trust. It runs the same EVM as `forge`, forks lazily from any RPC, and supports the cheat RPCs forkit builds on (`anvil_impersonateAccount`, `anvil_dealERC20`, `evm_snapshot`, `debug_traceCall`). Your production TypeScript talks to it over plain JSON-RPC, exactly as it talks to a real node. See [the landscape](landscape.md) for the trade-offs against the alternatives.

**Do I need Solidity?**
No. forkit is for testing TypeScript that talks to chains: routers, quoting, SDK calls, bundlers and bridges. Fixture contracts are optional.

**Is it fast?**
The first run of a pinned fork fetches state from the RPC. Later runs replay it from the [fork cache](guides/fork-cache-and-ci.md) with no network, and a whole e2e file replays in seconds. One anvil boots per `describeFork`, not per test, and a [shared fork](guides/shared-forks.md) boots once per run.

**Which runners?**
vitest, bun:test, jest (native ESM) and node:test, each through its own subpath. `createForkAdapter({ describe, it, hooks })` covers any other runner.

**Why are `warp` and `roll` relative?**
They mirror the spec's `f.warp(seconds)`: advance by an amount. Foundry's `vm.warp` and `vm.roll` are absolute. Also, anvil's block timestamps follow the wall clock as well, so `warp(n)` moves time by *at least* `n` seconds. For an exact or absolute timestamp, use viem's test actions on `f.client`: `setNextBlockTimestamp`, then `mine`. See the [cheatcode reference](reference/cheatcodes.md).

**Can tests in one fork suite run concurrently?**
No. They share one fork, and isolation is snapshot/revert around each test. Run fork suites serially inside a file. Files can still run in parallel, each with its own fork, or taking turns on a shared one.

**Does it work offline in CI?**
Yes. Commit `.forkit-cache` (or cache it), then run with `FORKIT_CACHE=offline`. For HTTP quote APIs, commit `.forkit-http`; CI replays them by default.

**Is it published?**
Not yet. `@condensate/forkit` is private until the maintainers decide. The license is also pending.
