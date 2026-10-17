# vitest-solana

Forks Solana mainnet-beta with surfpool, gives a fresh wallet wrapped SOL, and sends an SPL
`TransferChecked` through the real Token program, which loads from mainnet the first time the
transaction touches it. Instructions come from `@solana-program/token`, and transactions are
built and sent with `@solana/kit` 8.

The tests in [`test/transfer.test.ts`](test/transfer.test.ts):

- **alice sends bob 0.5 wrapped SOL.** `s.dealSol` pays alice's fee and `s.deal` gives her 2 wrapped
  SOL (and bob an empty token account). The transfer is signed by a fixed-seed keypair and sent with
  `sendAndConfirmTransactionFactory(s)`. Both balances and the Token program's `success` log are
  checked.
- **the next test starts clean.** The suite sets `resetEach: true`, so bob's token account from the
  first test is gone.
- **warp.** `s.warp(86_400)` moves the fork's `Clock` a day forward.

## Run it

You need surfpool 1.6.1 or newer. Inside this repo, the script installs the pinned release for you:

```sh
bun install                 # at the repo root
bun run test:svm:e2e        # in this directory: installs surfpool into .tools/, then vitest run
```

The fork source is `FORKIT_SVM_RPC_URL`, else Solana's public mainnet-beta RPC, which is rate
limited. A surfnet forks live state, not a pinned slot, so the test asserts on what the transfer
changed, never on absolute mainnet values. To copy this example into your own project, replace
`"workspace:*"` with a GitHub commit pin of forkit (see the root README) and install surfpool from
its [releases](https://github.com/solana-foundation/surfpool/releases).
