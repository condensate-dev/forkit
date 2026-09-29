# jest-bridge

Bridges 1,000 USDC from Base to Arbitrum through Across, under jest, with no live relayer. alice
deposits into Base's real SpokePool. `bridge.across(f).settle()` then fills the deposit on the
Arbitrum fork through Arbitrum's real SpokePool, the way an Across relayer would, and bob receives
the USDC there.

The forks are pinned at Base block 51,930,802 and Arbitrum block 509,904,348, 20 s apart, so the
deposit's deadlines (taken from Base's clock) are still open when the fill is checked against
Arbitrum's clock.

The tests in [`test/bridge.test.ts`](test/bridge.test.ts):

- **the forks are pinned 20 s apart.**
- **bob receives the output on Arbitrum, and the fill reports the fee.** alice's Base USDC falls by
  1,000; bob's Arbitrum USDC rises by the deposit's `outputAmount`; `fill.details.fee` is exactly
  the fee the deposit was built with (0.05 % + 0.02 USDC = 0.52 USDC).
- **a relayer that keeps extra.** The `outputAmount` option makes the simulated relayer deliver
  less than the deposit asked for, so you can test how your app handles it.
- **a deposit whose fill deadline has passed is not filled.** Warping Arbitrum two hours ahead
  makes `settle()` reject, and the deposit stays pending.

## Run it

```sh
bun install    # at the repo root
bun run test   # in this directory: NODE_OPTIONS=--experimental-vm-modules jest
```

jest runs on Node (>= 22.18) in native ESM mode, because viem and forkit are ESM-only; swc strips
the TypeScript. See [`jest.config.js`](jest.config.js).

The fork state for both chains replays from `.forkit-cache/` (`8453/` for Base, `42161/` for
Arbitrum), so no RPC is needed. Set `FORKIT_CACHE=offline` to make any missing state fail loudly.

## Re-record

Arbitrum's public RPC keeps only recent state, so you cannot re-record at the committed Arbitrum
block. Pick new pins and record straight away:

```sh
node pick-blocks.ts                 # prints BASE_BLOCK, BASE_TIMESTAMP, ARB_BLOCK, ARB_TIMESTAMP
# paste them into test/bridge.test.ts, then:
rm -rf .forkit-cache
bun run test                        # needs network
PATH=/path/to/anvil-1.8:$PATH bun run test   # if you support anvil 1.7 and 1.8, record with both
FORKIT_CACHE=offline bun run test   # check that the recording is complete
```

anvil 1.8 applies EIP-2935's block-hash history system call on Arbitrum, which reads storage
that 1.7 never asks for, so a recording made with only one version misses state the other needs. Alternatively, set
`FORKIT_RPC_URL_42161` to an archive endpoint and keep any pins you like. Then run
`bun run format` at the repo root and commit `.forkit-cache/`.

Keep every timestamp in the deposit absolute (the pinned block's timestamp, plus a fixed amount).
A value read from the clock at run time changes the deposit's relay hash on every run, and the
offline recording would miss the storage the fill reads.

## forkit features used

- `describeFork` / `itFork` from `@condensate/forkit/jest`, with a multi-chain fork.
- `bridge.across(f)` from `@condensate/forkit/bridges`: `poll()`, `settle()`, `pending`, and the
  `outputAmount` option.
- `across.outputAmount` and `across.fee` to build and check the fee, `across.spokePools` for the
  addresses, `spokePoolAbi` for the deposit call.
- `fill.details` (an `AcrossFillDetails`): fee, relayer, exclusivity, destination SpokePool.
- `f.expectBalanceChange` on both chains, `f.deal`, `f.dealNative`, `f.prank`, `f.warp`.
- `label` and `cacheDir`.
