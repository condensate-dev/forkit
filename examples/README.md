# forkit examples

Small projects, one per test runner. The EVM ones fork real chains at pinned blocks and ship their
fork recordings, so they run offline with no RPC. The Solana one forks live mainnet-beta with
surfpool, so it needs network.

| Example | Runner | What it shows |
|---|---|---|
| [`vitest-swap`](vitest-swap) | vitest | Fork Base, deal USDC, swap it on Uniswap v3, assert balance changes, gas snapshot |
| [`bun-multichain`](bun-multichain) | bun:test | Fork Base and Optimism side by side, work on both, isolation across both |
| [`jest-bridge`](jest-bridge) | jest | Bridge USDC from Base to Arbitrum through a simulated Across relayer |
| [`vitest-solana`](vitest-solana) | vitest | Fork Solana mainnet-beta with surfpool, deal wrapped SOL, send an SPL transfer, warp the clock |

You need [bun](https://bun.sh), Node >= 22.18 (for jest), and foundry's `anvil` (1.7.1 or newer) on
`PATH`.

```sh
bun install              # at the repo root: the examples are workspace packages
bun run test:examples    # the EVM examples
bun run test:svm:e2e     # the Solana example (and forkit/svm's own mainnet e2e); installs surfpool
```

Inside this repo the examples depend on `@condensate/forkit` through the workspace
(`"workspace:*"`). To copy one into your own project, copy its directory and replace that with the
published version.
