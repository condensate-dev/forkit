# bun-multichain

Forks Base (block 51,800,000) and Optimism (block 157,395,255) side by side, one anvil each, under
bun:test. The two blocks are 60 s apart.

The tests in [`test/multichain.test.ts`](test/multichain.test.ts):

- **each chain is its own anvil, pinned to its own block.** `f` is Base (the first target),
  `f.on(optimism)` is Optimism, and either handle reaches the other.
- **wraps ETH on Base and sends USDC on Optimism.** On Base, alice wraps 1 ETH through the WETH9
  predeploy. On Optimism, she sends 250 USDC to bob through Circle's USDC contract. Each step is
  checked with that chain's `expectBalanceChange`.
- **the next test starts clean on both chains.** `describeFork` snapshots every chain before each
  test and reverts every chain after it, so the WETH, the USDC and the mined blocks are gone.
- **each chain keeps its own clock.** Warping Optimism by a day leaves Base where it was.

## Run it

```sh
bun install    # at the repo root
bun run test   # in this directory: bun test --timeout 60000 ./test
```

The fork state for both chains replays from `.forkit-cache/` (`10/` for Optimism, `8453/` for
Base), so no RPC is needed. Set `FORKIT_CACHE=offline` to make any missing state fail loudly.

## Re-record

After changing a pinned block or adding a test that touches new state:

```sh
rm -rf .forkit-cache
bun run test                        # needs network: Base's and Optimism's public RPCs serve archive state
FORKIT_CACHE=offline bun run test   # check that the recording is complete
```

To use your own RPCs, set `FORKIT_RPC_URL_8453` and `FORKIT_RPC_URL_10`. anvil 1.8 reads some
state that 1.7 does not, so if you support both, record with each. Then run `bun run format` at
the repo root and commit `.forkit-cache/`.

## forkit features used

- `describeFork` / `itFork` from `@condensate/forkit/bun`, with an array of targets: a multi-chain
  fork, booted in parallel.
- `f.on(chain)`, called while tests are collected; it resolves once the forks are up.
- `f.forks`, `f.chain`, `f.rpcUrl`.
- Per-test isolation across every chain of the fork.
- `f.deal`, `f.dealNative`, `f.prank`, `f.warp` and `f.expectBalanceChange`, each on its own chain.
- `label` and `cacheDir`.
