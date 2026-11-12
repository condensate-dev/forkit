# Post-test explorer: `forkit explore`

A failing fork test usually leaves you with a revert reason and a stack trace. `forkit explore` shows you the whole run: every test with its failed assertion, every step of it (transactions, `deal`, `prank`, `warp`, snapshots), and every transaction with its decoded call tree, gas, events, token transfers and state changes. It works like a block explorer, but it covers only what your tests did, and it knows what a block explorer cannot: which test sent a transaction, as whom, and what it expected.

It has two parts:

1. **Run records.** With recording on, each test run writes `.forkit/runs/<id>.json`. The record holds the forks and their blocks, every transaction (target, calldata, decoded call, logs, gas, status, decoded call trace with each frame's events, and the state it changed), cheatcodes, labels, balance changes, bridge fills, HTTP replay hits and gas snapshots, grouped by test.
2. **`forkit explore [run]`** serves a local, read-only web UI over those records. It binds to `127.0.0.1`, loads nothing from the network, and ships as static files inside the package.

## Record a run

Recording is off by default. Turn it on with an environment variable:

```sh
FORKIT_RECORD=1 npx vitest run
FORKIT_RECORD=1 bun test
FORKIT_RECORD=1 npx jest
FORKIT_RECORD=1 node --test
```

Or turn it on from the test runner's config with `@condensate_dev/forkit/explore/record`:

```ts
// vitest.config.ts: every worker records, under one run id
export default defineConfig({
  test: { globalSetup: ["@condensate_dev/forkit/explore/record"] },
});
```

```js
// jest.config.js
export default { globalSetup: "@condensate_dev/forkit/explore/record" };
```

```sh
# bun: preload it (bun test runs in one process)
bun test --preload @condensate_dev/forkit/explore/record
```

As a setup file (vitest `setupFiles`, jest `setupFiles`), the module records the process that loads it.

| Variable | Default | Meaning |
|---|---|---|
| `FORKIT_RECORD` | off | `1` (or `true`) records the run. `0`, `false`, `off` and unset do not. |
| `FORKIT_RECORD_DIR` | `.forkit` in the working directory | Where run records go. |
| `FORKIT_RUN_ID` | derived | The run's id. Set it in CI to get a predictable file name, e.g. `FORKIT_RUN_ID=ci-$GITHUB_RUN_ID`. Letters, digits, `.`, `_` and `-` only. |

When `FORKIT_RUN_ID` is not set, every worker of one test-runner invocation still records into the same run. The first worker creates the id (`<UTC time>-<runner pid>`, e.g. `20260928T231455Z-91843`) and the others pick it up.

Recording costs a few JSON-RPC calls per transaction (receipt, block, two `debug_traceTransaction` calls, balance reads) against the local anvil. Each step is best effort: if a read fails, the record keeps a note and the test is unaffected.

### What is recorded

| | Where it comes from |
|---|---|
| Tests | `itFork` tests: suite, name, pass/fail, duration and the failure message, with the expected and actual values when the assertion error carries them. Activity in `beforeAll`/`afterAll` hooks is grouped under "setup & teardown". |
| Forks | Every fork boot: chain, pinned block (or live head), masked upstream RPC, fork cache hits and misses, boot time. |
| Transactions | Every `sendTransaction`, `writeContract` and `deployContract` on a fork client, including impersonated (`prank`) ones: from, to, value, calldata and the decoded call. Mined transactions also get their receipt (status, block, gas used, gas price, created contract), decoded events, a decoded call trace in which each frame carries the events it emitted (`callTracer` with `withLog`), and a state diff (the `prestateTracer` in diff mode). Transactions that revert at gas estimation, so are never mined, get a `debug_traceCall` trace and the decoded revert reason. |
| Balance changes | Per transaction: native value moved in the call trace (reverted frames excluded), the gas fee, and ERC-20 `Transfer` events. For each change, the balance after the transaction's block, and the token's symbol, decimals and name. |
| State diffs | Per mined transaction: every account it changed, with its balance, nonce, code size and each storage slot before and after. Slots get a best-effort name, such as `mapping(9)[alice]` or `mapping(10)[alice][SpokePool]`, found by hashing the run's labelled addresses and the transaction's own addresses with small slot numbers. |
| Deals | `deal` and `dealNative`: the balance each one set. |
| Cheats | `prank` (start and end), `warp`, `roll`, `snapshot` and `revertTo` made by the test, with the new block number and time after a `warp` or `roll`. The per-test isolation snapshot and revert are not recorded. |
| Bridge fills | `bridge.across`, `bridge.relay` and `bridge.custom` fills: deposit, origin and destination chains, fill transactions and output. |
| HTTP | `@condensate_dev/forkit/http` requests: fixture set, redacted URL, and hit, recorded, passthrough or unmatched. |
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

- **Runs.** Every recorded run, newest first: result, tests, transactions and chains.
- **Run.** Totals (tests, transactions, gas and fees, forks and blocks, cheats, fills), then **failures first**: each failed test with its message and its expected and actual values, the differing characters marked. Then every test (failed ones on top), every transaction, the forks, cross-chain fills with their fee, gas snapshots, labels and HTTP replay hits.
- **Test.** The timeline: every step in order, with its time offset and chain. Transactions and reverts show their decoded call and who sent them (`as alice` inside a `prank`); `deal`, `prank` and its end, `warp` (with the new time), `roll`, `snapshot` and `revertTo`, fills, HTTP hits and gas snapshots have their own rows. A failed test ends with its assertion, and a panel above shows expected against actual (a line diff for multi-line values). Beside it: net balance changes per holder and token, and gas by transaction.
- **Transaction.** Status, hash, from and to (with copy buttons), value, gas and fee, block and time, its test, and the previous and next transaction of that test. A revert names the frame it started in. Then:
  - **Call tree.** Collapsible and decoded: each frame's gas (with a bar), call type, target label, function and arguments, return values or revert reason, and the events it emitted at their place among its subcalls. Frames on the way to a revert open by default. Selecting a frame shows it in an inspector: from, to, value, gas and share of the transaction, arguments and returns as tables, its events, raw input and output. The trace is also available exactly as `forge test -vvvv` prints it.
  - **Gas by call.** An icicle: one bar per frame, as wide as its gas, children inside their caller. Click one to select that frame.
  - **Token transfers** as a flow (`alice → 1,000 USDC → SpokePool`), from ERC-20 `Transfer` events and ether moved in the trace, and **balance changes** with the balance before and after.
  - **State changes.** Each changed account: its balance, nonce and code before and after, and its storage slots, named where possible and read as an address, a number or a token amount.
  - **Events**, each linked to the frame that emitted it, and the decoded **input** with the raw calldata.
  - **Cross-chain.** For a bridge deposit or fill, the deposit and its fill side by side, with the amounts in and out and the fee.
  - **Copy as code.** Two snippets that reproduce the transaction: a forkit test that replays the test's steps on that chain (deals, warps, rolls, and each transaction as its sender) up to and including this one, and a viem call that sends the transaction on an anvil fork of the same block.
- **Address.** The label and full address, then the balance of each token over the run as a step chart (hover or focus a point; each test boundary is marked, since every test starts from its snapshot), with every step as a table beneath. Then every transaction that touches the address (sent it, called it, or moved its balance) and the storage slots transactions changed on it.

Addresses show their label everywhere and link to their address view.

### Finding things

- **Search** (`/`): a transaction hash (or its first characters), an address, a label, a token symbol, a test name or a function name. Arrow keys pick a result; Enter opens it.
- **Keyboard:** `j` and `k` move through the page's list (runs, tests, timeline steps, call frames), Enter or `o` opens the selected row (or expands a frame), `h` and `l` collapse and expand in the call tree, `u` goes up a level, and `?` lists the keys.
- **Deep links.** Every view is a URL, and so is every selection: `#/run/<id>/tx/<tx>?frame=0.1.2` opens a transaction with that call frame selected, `?step=4` a test with that timeline step selected, `?section=state` a transaction at its state changes. Copy the address bar to share one.
- **Large runs.** Lists longer than a screenful (transactions, timeline steps, call frames) render only the rows in view, in their own scroll box, so a run with thousands of transactions opens as fast as a small one.

The UI follows the system's light or dark setting. On a phone it keeps to the screen's width: wide tables and call trees scroll inside their own boxes.

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

`runs/<id>.json` is plain JSON (`RunRecord` in `@condensate_dev/forkit/explore`, `version: 1`). Every bigint (wei amounts, gas, block numbers) is a decimal string, and every address is lowercase `0x` hex. Tools can read it directly, or use `readRun`, `listRuns` and `startExploreServer` from `@condensate_dev/forkit/explore`.

```ts
interface RunRecord {
  version: 1;
  id: string;
  startedAt: number; // ms since the epoch
  updatedAt: number;
  workers: { worker: string; pid: number; argv: string[]; startedAt: number; updatedAt: number }[];
  forks: { chainId; chainName; nativeSymbol; blockNumber?; upstream; rpcUrl; bootMs; cache? }[];
  tests: {
    key; suite; name; status: "pass" | "fail" | "running"; startedAt; durationMs?;
    error?; expected?; actual?;
  }[];
  txs: {
    id; test?; chainId; kind; hash?; mined; status: "success" | "reverted" | "unknown";
    from?; to?; data?; value?; call?; blockNumber?; blockHash?; blockTimestamp?;
    gasUsed?; effectiveGasPrice?; contractAddress?; logs; trace?; traceText?;
    error?; revert?; balanceChanges: { address; token; delta; after? }[]; notes?;
    stateDiff?: {
      address; balance?: { before; after }; nonce?: { before; after }; code?: { before; after };
      storage: { slot; before; after; hint? }[];
    }[];
  }[];
  // trace frames: { type; from; to?; value?; gasUsed?; input; output?; error?; revert?; call?;
  //   result?; calls?; logs?: { address; topics; data; position; index?; event? }[] }
  blocks: { chainId; number; hash; timestamp?; txs: string[] }[];
  deals, fills, http, gas: [...];           // each with test?, worker and ts
  cheats?: { cheat; chainId; account?; seconds?; blocks?; snapshotId?; blockNumber?; timestamp? }[];
  labels: Record<string, string>;           // address → label
  tokens: Record<string, { symbol?; decimals?; name? }>; // "<chainId>:<address>"
}
```

`cheats` is absent in records from forkit versions before cheats were recorded; the explorer reads those records as before. Transaction ids (`<worker>:<n>`) are unique within a run. Hashes are not: a test that reverts to a snapshot and sends the same transaction again produces the same hash.

## Limitations

- **Concurrent tests in one worker.** Activity is attributed to the test that is running in that worker, so with `test.concurrent` (or anything else that overlaps tests in one process) transactions can land under the wrong test. Tests in different workers are unaffected.
- **Reused process ids.** Workers find their runner's run through `parts/.roots/<pid>`. Where the runner gets the same pid every time (a container with a bind-mounted workspace), invocations less than six hours apart can merge into one run. Set `FORKIT_RUN_ID` per invocation there.

## Screenshots

The explorer's screenshot test renders a committed run record (`packages/forkit/test/fixtures/explore/showcase.json`) at 390, 1024 and 1440 px, light and dark, in headless Chromium:

```sh
cd packages/forkit
npx playwright install chromium    # once
bun run test:screens               # PNGs in /tmp/forkit-explore-screens (FORKIT_SCREENS_DIR)
```

The test also fails if the UI requests anything off `127.0.0.1`, logs an error (a content security policy violation is one), or scrolls the page sideways at any width. It then drives the UI: keyboard navigation, search, frame deep links, copy as code, and a synthetic 5,000-transaction run that must render only the rows in view. The stylesheet's colour tokens are checked for WCAG AA contrast, light and dark, by `test/unit/explore-ui.vitest.ts`. `bun run explore:fixture` re-records the showcase run from `test/explore/showcase.fixture.ts`. It uses the e2e pins and fork recordings, and one of its tests fails on purpose.
