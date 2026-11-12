# forkit examples

Three small projects, one per test runner. Each one forks real chains at pinned blocks and ships
its fork recording, so it runs offline with no RPC.

| Example | Runner | What it shows |
|---|---|---|
| [`vitest-swap`](vitest-swap) | vitest | Fork Base, deal USDC, swap it on Uniswap v3, assert balance changes, gas snapshot |
| [`bun-multichain`](bun-multichain) | bun:test | Fork Base and Optimism side by side, work on both, isolation across both |
| [`jest-bridge`](jest-bridge) | jest | Bridge USDC from Base to Arbitrum through a simulated Across relayer |

You need [bun](https://bun.sh), Node >= 22.18 (for jest), and foundry's `anvil` (1.7.1 or newer) on
`PATH`.

```sh
bun install              # at the repo root: the examples are workspace packages
bun run test:examples    # all three
```

Inside this repo the examples depend on `@condensate_dev/forkit` through the workspace
(`"workspace:*"`). To copy one into your own project, copy its directory and replace that with the
published version.
