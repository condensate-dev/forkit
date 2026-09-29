# Terminal output: `@condensate/forkit/reporter`

After a run, forkit prints what happened on the forks:

- **Boot lines:** each fork's chain, block, RPC host (secrets masked), whether the fork cache answered everything, and the boot time.
- **Per-test summary:** txs sent, gas used, and a compact table of balance changes per labelled address and token, with signs.
- **Failure traces:** a Foundry-style call trace, decoded with labels and known ABIs, plus the failing expectation as expected vs actual.
- **Bridge lines:** each simulated fill: deposit id, origin → destination, fill tx, fee and settled amount.
- **Gas snapshot diff:** every measured label against the committed `.gas-snapshot`, with the delta.

It works in every runner forkit supports. vitest gets a real reporter; bun:test gets a preload; jest and node:test call `formatRun()` themselves.

## Sample

Real output from two vitest files with the reporter enabled (`NO_COLOR=1`). The first file is the Base → Arbitrum Across end-to-end test. The second forks Base USDC; it has a gas snapshot, and one test fails on purpose.

```
forkit · test/e2e/base-arbitrum-across.vitest.ts
  ⛓ Arbitrum One (42161) · block 509,730,857 · arb1.arbitrum.io · cache hit (39 reads) · booted in 704 ms
  ⛓ Base (8453) · block 51,907,866 · mainnet.base.org · cache hit (43 reads) · booted in 732 ms
  ✓ Base USDC → Arbitrum via simulated Across: recipient paid, fee accounting matches the quote  3 txs · 244,593 gas · 5.08 s
        balance change   USDC(base) (Base)  USDC(arb) (Arbitrum One)   ETH (Base)  ETH (Arbitrum One)
        alice                       -1,000                            -0.0001248…
        SpokePool(base)             +1,000
        across relayer                                   -999.890778                      -0.0001224…
        bob                                              +999.890778
        ⇄ across deposit 8453:0xbf5a…1507:1 · Base → Arbitrum One · fill 0x23f1…f16b · fee 0.109222 USDC(arb) · settled 999.890778 USDC(arb)

forkit · test/e2e/usdc-base.vitest.ts
  ⛓ Base (8453) · block 51,800,000 · mainnet.base.org · cache hit (43 reads) · booted in 823 ms
  ✓ USDC on Base › alice pays bob  1 tx · 44,855 gas · 1.35 s
        balance change    USDC           ETH
        alice           -250.5  -0.00004507…
        bob             +250.5
  ✗ USDC on Base › rejects a transfer beyond the balance  1 reverted · 219 ms
        ✗ forkit: expected Error("ERC20: insufficient balance"), got Error("ERC20: transfer amount exceeds balance").
        Trace:
          [35960] USDC::transfer(bob (0x0000…0B0b), 2000000000)
            ├─ [7361] FiatTokenV2_2::transfer(bob (0x0000…0B0b), 2000000000) [delegatecall]
            │   └─ ← [Revert] Error("ERC20: transfer amount exceeds balance")
            └─ ← [Revert] Error("ERC20: transfer amount exceeds balance")
        Expected vs actual:
          - expected  ERC20: insufficient balance
          + actual    Error("ERC20: transfer amount exceeds balance")

gas snapshot · .gas-snapshot (write)
  label          snapshot     now       Δ
  USDC transfer    38,112  44,855  +6,743  +17.69%
```

In a terminal, negative deltas are red and positive ones green. Gas increases are red and decreases green. Reverts are red, returns green, and call targets cyan.

## Setup

### vitest

Add the setup file and the reporter:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["@condensate/forkit/reporter/setup"],
    reporters: ["default", "@condensate/forkit/reporter"],
  },
});
```

The report prints once, after vitest's own summary, with one block per test file. You need both parts: the setup file collects events in each worker, and the reporter prints them in the main process (see [How it works](#how-it-works)).

To pass options, use an instance:

```ts
import { ForkitReporter } from "@condensate/forkit/reporter";

reporters: ["default", new ForkitReporter({ color: false, tokens: { [USDC]: { symbol: "USDC", decimals: 6 } } })],
```

### bun:test

bun:test has no custom reporter API: `--reporter` accepts only `junit` and `dots`. forkit therefore ships a preload that collects events for the whole `bun test` process (bun runs every file in one process) and prints the report after the last test:

```toml
# bunfig.toml
[test]
preload = ["@condensate/forkit/reporter/bun"]
```

or `bun test --preload @condensate/forkit/reporter/bun`. The report is a single block titled `bun test`, and it is not split per file.

### jest and node:test

Collect in the test file and print when its tests are done:

```ts
import { collectRun, formatRun } from "@condensate/forkit/reporter";

const run = collectRun();
afterAll(async () => {            // node:test: after(async () => { ... })
  console.log(formatRun(await run.snapshot(), { title: "swap.test.ts" }));
});
```

Call `collectRun()` at the top of the file, before any fork boots, so it sees the boot events. jest gives each file its own module registry, so each file collects its own run.

`formatRun` also accepts a plain array of events, for example from `onForkitEvent`. Without the run log from `collectRun()` it uses this process's labels, and token amounts stay in raw units.

## What each part shows

**Boot line.** The masked upstream's host, from `fork:boot`. `cache hit (N reads)` means the [fork cache](fork-cache-and-ci.md) served every request during boot. `cache miss (M of N upstream)` means M went to the network. `no cache` means the cache is off, and `live head (unpinned)` means no block was pinned.

**Per-test table.** The balances come from receipts. forkit reads each transaction's receipt inside the test, right after it is mined. The table counts:

- every ERC-20 `Transfer` log (from −, to +);
- each transaction's native `value`;
- the gas its sender paid (`gasUsed × effectiveGasPrice`).

Rows are addresses: your `label()` if there is one, else a short address (`address(0)` for mints and burns). Columns are tokens: your label, else the token's `symbol()`, with its `decimals()` applied. Both are read from the fork while it is up. With forks on more than one chain, headers name the chain. Amounts show up to 6 decimals; `…` marks a cut. Bridge relayers and solvers without a label show as `across relayer` or `relay solver`.

**Failure.** The error's first lines come first; viem's `Contract Call:` and `Docs:` sections are dropped. Next comes the trace of the revert behind the error: forkit's decoded trace (`traces` is on by default), from the error message or from the `tx:reverted` event the error came from. Last is the expected-vs-actual diff: from `ForkitAssertionError` (`expectRevert`, `expectBalanceChange`, gas `check` mode), from the runner's own assertion error, or from vitest's failure. Multi-line values get a line diff.

**Bridge line.** Built from `bridge:fill`. The settled amount is `outputAmount`. The fee is `details.fee`, in the delivered token, which is found by matching a `Transfer` of `outputAmount` in the fill's receipts (or Relay's `currency`).

**Gas snapshot diff.** For each label measured in the run, it shows the value committed before the run, the latest measurement, and the delta with a percentage. A label with no committed value shows as `new`.

## Colour, `NO_COLOR` and CI

Output is plain text unless it goes to a terminal. In order:

1. `NO_COLOR` set to anything non-empty ([no-color.org](https://no-color.org)): plain.
2. `FORCE_COLOR` set: colour, unless it is `0` or `false`.
3. `CI` set (and not `0`/`false`) or `TERM=dumb`: plain.
4. Otherwise: colour only if stdout is a TTY.

`color: true | false` in `formatRun`'s options or the reporter's options overrides all of these. Colours are plain ANSI escapes, with no dependency. Plain output is exactly the coloured output with the escapes stripped.

## How it works

Run events (`onForkitEvent`) are emitted where tests run. vitest runs tests in worker processes, but reporters run in the main process. The two halves talk through test metadata:

1. The setup file calls `collectRun()` in each worker. It collects `fork:boot`, `tx:sent`, `tx:mined`, `tx:reverted`, `bridge:fill`, `gas:snapshot` and `test:start`/`test:end`. It also snapshots the labels of the addresses involved and reads each transferred token's `decimals()`/`symbol()` while the fork is up.
2. After each test, and after each file, it stores the events since the last hand-off in `task.meta.forkit` as JSON. bigints travel as `{ "$bigint": "123" }`.
3. The reporter reads `meta()` from every test and module in `onTestRunEnd` and renders each file with `formatRun`.

Tests written with `itFork` bring their own `test:start`/`test:end`. For a plain `test` that calls `fork()` itself, the reporter brackets its events using vitest's result.

bun:test runs everything in one process, and jest and node:test run a whole file in one process, so no transport is needed there.

## Limitations

- **Balances come from receipts.** The table covers ERC-20 `Transfer` logs, native `value` and gas. It does not cover internal ETH transfers (a contract forwarding value, visible only in a trace), rebasing balance changes that emit no `Transfer`, or cheat writes (`deal`, `dealNative`, or anvil `setBalance`), which are not transactions.
- **Receipts need automine** (forkit's default). With interval mining, `tx:mined` is not emitted and the table stays empty.
- **An offline fork cache can't read token metadata** unless the reads were recorded. On forks whose cache is `offline`, forkit skips `decimals()`/`symbol()` (so the cache does not warn about misses the test never caused), and amounts stay in raw units. Pass `tokens` to name and scale them. With a `readwrite` cache, the reads are recorded like any other.
- **Concurrent tests in one file.** Events go to the test that was running when they were handed off, so `test.concurrent` can blur which test sent what.
- **bun:test:** no per-file split, and only `itFork` tests appear as tests. Events from a plain `test` show as `(outside tests)`, because the preload cannot see bun's test results.
- **Traces** are forkit's decoded traces. With `traces: false` in the fork options, failures show without one.
