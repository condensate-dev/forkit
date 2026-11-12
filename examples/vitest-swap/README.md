# vitest-swap

Forks Base at block 51,800,000, gives a fresh account 1,000 USDC, and swaps it for WETH through
Uniswap v3's SwapRouter02, with calldata built from the router's public ABI.

The tests in [`test/swap.test.ts`](test/swap.test.ts):

- **swaps 1,000 USDC for exactly the quoted WETH.** QuoterV2 prices the swap on the same pinned
  state, so the swap must deliver exactly that amount. `f.expectBalanceChange` checks both sides:
  USDC down by 1,000, WETH up by the quote. The swap's gas goes into `.gas-snapshot`.
- **reverts when the pool cannot meet `amountOutMinimum`.** Asks for one wei more than the quote
  and expects SwapRouter02's `Too little received`.
- **each test starts from the pinned block again.** The swap from the first test is gone.

## Run it

```sh
bun install    # at the repo root
bun run test   # in this directory: vitest run
```

The fork state replays from `.forkit-cache/`, so no RPC is needed. Set `FORKIT_CACHE=offline` to
make any missing state fail loudly instead of being fetched.

With `CI` set, `f.gasSnapshot` checks the committed `.gas-snapshot` and fails if the swap's gas
changed. Without it, it rewrites the file.

## Re-record

After changing the pinned block or adding a test that touches new state:

```sh
rm -rf .forkit-cache .gas-snapshot
bun run test                        # needs network: Base's public RPC serves archive state
FORKIT_CACHE=offline bun run test   # check that the recording is complete
```

To use your own RPC, set `FORKIT_RPC_URL_8453`. anvil 1.8 reads some state that 1.7 does not, so
if you support both, record with each. Then run `bun run format` at the repo root (biome formats
the recording) and commit `.forkit-cache/` and `.gas-snapshot`.

## forkit features used

- `describeFork` / `itFork` from `@condensate_dev/forkit/vitest`: one anvil per `describeFork`, each
  test reverted to a clean snapshot.
- `f.deal` (ERC-20) and `f.dealNative`.
- `f.prank`: send as `alice` without her key.
- `f.expectBalanceChange`: exact balance deltas, nested for both tokens.
- `expectRevert` with a revert reason string.
- `label`: names in errors and traces (`alice`, `USDC`, `SwapRouter02`).
- `f.gasSnapshot`: a `forge snapshot`-style gas file.
- `cacheDir`: the fork recording, committed next to the test.
