# Troubleshooting

**`could not run \`anvil --version\``: test collection fails.**
anvil is not on `PATH`. Install foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`). forkit fails at collection on purpose: a fork suite that cannot run is a broken environment, not a skipped test.

**`anvil did not become ready within …ms`.**
The public RPC is slow or rate limited. Set `FORKIT_RPC_URL_<chainId>` to a paid endpoint, raise `bootTimeoutMs`, or record the fork once and replay it with `FORKIT_CACHE=offline`.

**`ForkCacheMissError`, or `offline and eth_… is not in the fork cache`.**
The test touched state the recording doesn't have. `ForkCacheMissError` comes when the fork stops, and lists every request that missed with its params, including ones anvil made on its own or the code under test caught. Re-record: run once with network and `FORKIT_CACHE=readwrite` (the default). If it happens on every run, something in the test isn't deterministic: a random key, a `Date.now()`-based value or deadline, an unpinned block, an ERC-4337 nonce key left at viem's default, or wall-clock block times on an Ethereum fork under anvil 1.8. See [making replays deterministic](guides/fork-cache-and-ci.md#making-replays-deterministic).

**`failed to create genesis` / `Resource not found` right at boot.**
The recording came from a different upstream at the same block number, e.g. a throwaway local anvil. Delete that chain's recording, or point `cacheDir` somewhere else for local-upstream tests.

**`itFork must be called inside a describeFork body`.**
`itFork` needs an enclosing `describeFork`, directly or through nested `describe` blocks. A plain `it` outside one can't reach a fork.

**A write "succeeded" but nothing changed.**
With an explicit `gas`, anvil mines a reverting impersonated transaction and returns its hash. Check `receipt.status`, or drop `gas` so forkit estimates first and the revert throws. See [how writes behave](guides/assertions-and-traces.md#how-writes-behave).

**`deal` fails with a derived or rebasing balance.**
The token computes `balanceOf` (e.g. from shares), so no storage write sets an exact balance. Fund the account the way the protocol does, e.g. with a real mint or deposit through `prank`.

**`gas for "…" changed` in CI.**
CI runs gas snapshots in `check` mode. If the change is intended, run locally with `FORKIT_GAS_SNAPSHOT=write` and commit `.gas-snapshot`.

**The bundler hangs or fails after a revert.**
Start `bundler(f)` before any snapshot, in `beforeAll`. Reverting past its start undoes alto's deployed helpers and the executors' funding. See [ERC-4337](guides/erc-4337.md#lifecycle).

**Different behaviour on anvil 1.7 and 1.8.**
forkit supports both, and CI runs both. anvil 1.8 changed how forks read state (block-hash pins, upstream probes) and can answer a write before its state is visible; forkit compensates for all of that. If you hit a difference forkit doesn't handle, report it with both versions' output.
