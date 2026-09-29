# Post-test explorer: `forkit explore`

A failing fork test usually leaves you with a revert reason and a stack trace. `forkit explore` shows you the whole run: every test, every transaction with its decoded call, call trace and events, and every balance that moved. It works like a block explorer, but it covers only what your tests did.

It has two parts:

1. **Run records.** With recording on, each test run writes `.forkit/runs/<id>.json`. The record holds the forks and their blocks, every transaction (target, calldata, decoded call, logs, gas, status and decoded call trace), labels, balance changes, bridge fills, HTTP replay hits and gas snapshots, grouped by test.
2. **`forkit explore [run]`** serves a local, read-only web UI over those records. It binds to `127.0.0.1`, loads nothing from the network, and ships as static files inside the package.

## Record a run

Recording is off by default. Turn it on with an environment variable:

```sh
FORKIT_RECORD=1 npx vitest run
FORKIT_RECORD=1 bun test
FORKIT_RECORD=1 npx jest
FORKIT_RECORD=1 node --test
```

Or turn it on from the test runner's config with `@condensate/forkit/explore/record`:

```ts
// vitest.config.ts: every worker records, under one run id
export default defineConfig({
  test: { globalSetup: ["@condensate/forkit/explore/record"] },
});
```

```js
// jest.config.js
export default { globalSetup: "@condensate/forkit/explore/record" };
```

```sh
# bun: preload it (bun test runs in one process)
bun test --preload @condensate/forkit/explore/record
```

As a setup file (vitest `setupFiles`, jest `setupFiles`), the module records the process that loads it.

| Variable | Default | Meaning |
|---|---|---|
| `FORKIT_RECORD` | off | `1` (or `true`) records the run. `0`, `false`, `off` and unset do not. |
| `FORKIT_RECORD_DIR` | `.forkit` in the working directory | Where run records go. |
| `FORKIT_RUN_ID` | derived | The run's id. Set it in CI to get a predictable file name, e.g. `FORKIT_RUN_ID=ci-$GITHUB_RUN_ID`. Letters, digits, `.`, `_` and `-` only. |

When `FORKIT_RUN_ID` is not set, every worker of one test-runner invocation still records into the same run. The first worker creates the id (`<UTC time>-<runner pid>`, e.g. `20260928T231455Z-91843`) and the others pick it up.

Recording costs a few JSON-RPC calls per transaction (receipt, block, `debug_traceTransaction`, balance reads) against the local anvil. Each step is best effort: if a read fails, the record keeps a note and the test is unaffected.

### What is recorded

| | Where it comes from |
|---|---|
| Tests | `itFork` tests: suite, name, pass/fail, duration and the failure message. Activity in `beforeAll`/`afterAll` hooks is grouped under "setup & teardown". |
| Forks | Every fork boot: chain, pinned block (or live head), masked upstream RPC, fork cache hits and misses, boot time. |
| Transactions | Every `sendTransaction`, `writeContract` and `deployContract` on a fork client, including impersonated (`prank`) ones: from, to, value, calldata and the decoded call. Mined transactions also get their receipt (status, block, gas used, gas price, created contract), decoded events and a decoded call trace. Transactions that revert at gas estimation, so are never mined, get a `debug_traceCall` trace and the decoded revert reason. |
| Balance changes | Per transaction: native value moved in the call trace (reverted frames excluded), the gas fee, and ERC-20 `Transfer` events. For each change, the balance after the transaction's block, and the token's symbol, decimals and name. |
| Deals | `deal` and `dealNative`: the balance each one set. |
| Bridge fills | `bridge.across`, `bridge.relay` and `bridge.custom` fills: deposit, origin and destination chains, fill transactions and output. |
| HTTP | `@condensate/forkit/http` requests: fixture set, redacted URL, and hit, recorded, passthrough or unmatched. |
| Gas snapshots | `gasSnapshot` labels, gas, and the committed value. |
| Labels | Every `label()` made during the run. |

Calls, events, return values and custom errors are decoded against the ABIs forkit knows. `writeContract` and `deployContract` register theirs automatically; call `registerAbi(abi)` for contracts that are only reached indirectly.

The fork waits for the recorder before it reverts or stops: `revertTo` (and so the per-test snapshot revert) and `stop` let pending receipt and trace reads finish first. After an `evm_revert`, anvil can no longer find the transactions it undid.

## Open the explorer

```sh
npx forkit explore            # the run list
npx forkit explore latest     # the newest run
npx forkit explore 20260928T231455Z-91843
npx forkit explore path/to/run.json          # any run record file, e.g. a CI artifact
npx forkit explore --dir ../other/.forkit --port 4000
```

It prints the URL (`http://127.0.0.1:<free port>/…`) and serves until Ctrl-C. It is read-only: the server answers `GET` and `HEAD` only, rejects requests whose `Host` is not the loopback address, and sends a strict content security policy. The UI is plain HTML, CSS and JavaScript from the package. It uses system fonts and makes no CDN or network requests.

### Views

- **Runs.** Every recorded run, newest first: result, tests, transactions, fills, chains and duration.
- **Run.** Totals, then tests grouped by suite (transactions, gas, reverts and time for each), every transaction, the forks, cross-chain fills, labels, gas snapshots and HTTP replay hits.
- **Test.** A timeline of the test: transactions and reverts, deals, bridge fills, HTTP hits and gas snapshots, each with its time offset and chain. Beside it, the net balance changes of the test's transactions per holder and token, signed, with each balance after. A failed test shows its failure message.
- **Transaction.** Status, hash, chain, block and time, from and to, value, gas and fee. Then the decoded input (a tuple, `bytes32`-encoded addresses and labels are rendered for reading), the call trace as a collapsible tree with gas, decoded arguments, return values and revert reasons, the decoded events and the balance changes. The trace is also available exactly as `forge test -vvvv` prints it. If the transaction is a bridge deposit or fill, a panel links the origin deposit to its destination fill.
- **Address.** The label and, per chain and token, the balance history: each deal that set it and each transaction that changed it, with the balance after. Then the transactions that involve the address.

The search box takes an address, a transaction hash or a label.

## Where the files go

```
.forkit/
  runs/<id>.json             the merged run record: what the explorer shows
  parts/<id>/<worker>.jsonl  one append-only file per worker process (or thread)
  parts/.roots/<pid>         which run a test runner's workers are recording
```

Each worker appends to its own part file, so parallel workers never write the same file, and a worker that is killed keeps everything up to its last complete line. Parts are merged into `runs/<id>.json` under a lock, and the file is replaced atomically. Merges happen shortly after each test, when a worker (or the global setup's process) exits, and whenever `forkit explore` or `readRun` opens a run whose parts are newer than its record. A runner that kills its workers can leave `runs/<id>.json` slightly behind; the explorer always shows the complete run.

**Add `.forkit/` to your `.gitignore`.** Run records are local debugging output, and they can grow to several megabytes for large suites. To keep one from CI, upload `.forkit/runs/` as an artifact and open it with `forkit explore <file>`.

## The run record

`runs/<id>.json` is plain JSON (`RunRecord` in `@condensate/forkit/explore`, `version: 1`). Every bigint (wei amounts, gas, block numbers) is a decimal string, and every address is lowercase `0x` hex. Tools can read it directly, or use `readRun`, `listRuns` and `startExploreServer` from `@condensate/forkit/explore`.

```ts
interface RunRecord {
  version: 1;
  id: string;
  startedAt: number; // ms since the epoch
  updatedAt: number;
  workers: { worker: string; pid: number; argv: string[]; startedAt: number; updatedAt: number }[];
  forks: { chainId; chainName; nativeSymbol; blockNumber?; upstream; rpcUrl; bootMs; cache? }[];
  tests: { key; suite; name; status: "pass" | "fail" | "running"; startedAt; durationMs?; error? }[];
  txs: {
    id; test?; chainId; kind; hash?; mined; status: "success" | "reverted" | "unknown";
    from?; to?; data?; value?; call?; blockNumber?; blockHash?; blockTimestamp?;
    gasUsed?; effectiveGasPrice?; contractAddress?; logs; trace?; traceText?;
    error?; revert?; balanceChanges: { address; token; delta; after? }[]; notes?;
  }[];
  blocks: { chainId; number; hash; timestamp?; txs: string[] }[];
  deals, fills, http, gas: [...];           // each with test?, worker and ts
  labels: Record<string, string>;           // address → label
  tokens: Record<string, { symbol?; decimals?; name? }>; // "<chainId>:<address>"
}
```

Transaction ids (`<worker>:<n>`) are unique within a run. Hashes are not: a test that reverts to a snapshot and sends the same transaction again produces the same hash.

## Limitations

- **Concurrent tests in one worker.** Activity is attributed to the test that is running in that worker, so with `test.concurrent` (or anything else that overlaps tests in one process) transactions can land under the wrong test. Tests in different workers are unaffected.
- **Reused process ids.** Workers find their runner's run through `parts/.roots/<pid>`. Where the runner gets the same pid every time (a container with a bind-mounted workspace), invocations less than six hours apart can merge into one run. Set `FORKIT_RUN_ID` per invocation there.

## Screenshots

The explorer's screenshot test renders a committed run record (`packages/forkit/test/fixtures/explore/showcase.json`) at 390 px and 1440 px in headless Chromium:

```sh
cd packages/forkit
npx playwright install chromium    # once
bun run test:screens               # PNGs in /tmp/forkit-m9-screens (FORKIT_SCREENS_DIR)
```

The test also fails if the UI requests anything off `127.0.0.1`, logs an error, or scrolls sideways at 390 px. `bun run explore:fixture` re-records the showcase run from `test/explore/showcase.fixture.ts`. It uses the e2e pins and fork recordings, and one of its tests fails on purpose.
