# Foundry → forkit

For Solidity devs who know `forge test`: each Foundry cheatcode or forge feature, and what to use in forkit. Foundry semantics come from the [Foundry docs](https://getfoundry.sh); each section links the pages it relies on.

## The one difference that explains the rest

A Foundry test is a contract, and cheatcodes change the EVM it runs in: `vm.warp` sets `block.timestamp` in place, and `vm.prank` changes `msg.sender` for the next call the test contract makes.

forkit drives a real anvil node over JSON-RPC. Every write is a real transaction, and anvil mines it in its own block (automine). So:

- the sender of a transaction is both `msg.sender` and `tx.origin`, and it pays its own gas;
- moving time or block number means mining blocks, and anvil never goes back except through `revertTo`;
- there is no "next call": an assertion takes the promise of the exact call it checks.

## The same test in both

```solidity
function setUp() public {
    vm.createSelectFork("base", 21_000_000); // alias from [rpc_endpoints]
    deal(USDC, alice, 1_000e6);
}

function test_transfer() public {
    vm.prank(alice);
    IERC20(USDC).transfer(bob, 500e6);
    assertEq(IERC20(USDC).balanceOf(bob), 500e6);
}
```

```ts
import { erc20Abi, parseEther } from "viem";
import { base } from "viem/chains";
import { beforeAll } from "vitest";
import { describeFork, itFork } from "@condensate/forkit/vitest";

// RPC: FORKIT_RPC_URL_8453, else base's default RPC.
describeFork("transfer", { chain: base, blockNumber: 21_000_000n }, (f) => {
  beforeAll(async () => {
    await f.deal(USDC, alice, 1_000_000_000n);
    await f.dealNative(alice, parseEther("1")); // alice sends a real transaction, so she pays gas
  });

  itFork("moves USDC", async () => {
    await f.expectBalanceChange(USDC, bob, 500_000_000n, () =>
      f.prank(alice, (c) =>
        c.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [bob, 500_000_000n] }),
      ),
    );
  });
});
```

`f.client` is a viem client with test, public and wallet actions. It has no default account, so a write goes through `f.prank(who, fn)` or passes `account` explicitly. Its test actions (`setStorageAt`, `setCode`, `setNonce`, `setNextBlockTimestamp`, `mine` and others) cover several cheatcodes that forkit does not wrap. The tables below point to them where they apply.

## Forking

| Foundry | forkit | Note |
|---|---|---|
| `forge test --fork-url <url>`, `eth_rpc_url` | `fork({ chain, forkUrl })`, or `FORKIT_RPC_URL_<chainId>` | Without either, forkit uses the viem chain's default RPC. |
| `--fork-block-number <n>`, `fork_block_number` | `blockNumber: n` (a bigint) | An unpinned fork warns and is never cached, because the run is not reproducible. |
| `[rpc_endpoints]` alias | `FORKIT_RPC_URL_<chainId>`, e.g. `FORKIT_RPC_URL_8453` | Keyed by chain id, not by name. |
| `vm.createSelectFork(url, block)` | `await fork({ chain, forkUrl, blockNumber })` | Boots an anvil and returns a handle. In a test file, use `describeFork(name, target, body)`. |
| `vm.createFork(...)` + `vm.selectFork(id)` | `fork([a, b])` + `f.on(chain)` | Every chain is its own anvil, all running at once. You select by chain object, not fork id; `f.chain` is the selected one. |
| `vm.activeFork()` | `f.chain` | Also `f.forks`, every handle in the order given. |
| `vm.createFork(url, txHash)` | none | forkit forks at a block only. |
| `vm.rollFork(block)` | none | Boot another fork at the other block. viem's `reset` is on `f.client`, but forkit neither documents nor tests it. |
| `vm.makePersistent(addr)` | not needed | Forks are separate chains; no state is carried between them, persistent or not. |

`fork([...])` takes one entry per chain: two forks of the same chain in one call throw. For two blocks of one chain, call `fork()` twice.

Sources: [createFork](https://getfoundry.sh/reference/cheatcodes/create-fork), [selectFork](https://getfoundry.sh/reference/cheatcodes/select-fork), [createSelectFork](https://getfoundry.sh/reference/cheatcodes/create-select-fork), [rollFork](https://getfoundry.sh/reference/cheatcodes/roll-fork), [fork testing](https://getfoundry.sh/forge/fork-testing).

## Balances

| Foundry | forkit | Note |
|---|---|---|
| `vm.deal(who, amount)` | `f.dealNative(who, amount)` | Sets the native balance to exactly `amount`, like `vm.deal`. |
| `deal(token, who, amount)` (forge-std) | `f.deal(token, who, amount)` | Tries `anvil_dealERC20`, falls back to finding the balance slot, then reads `balanceOf` back. A rebasing or derived balance throws `DealError` instead of passing silently. |
| `deal(token, who, amount, true)` | none | forkit never adjusts `totalSupply`. |
| (no equivalent) | `f.deal(token, who, amount, { via: "storage" })` | Skip `anvil_dealERC20` and write the discovered slot. `via: "anvil_dealERC20"` uses only that method. |
| `hoax(who, amount)` | `await f.dealNative(who, amount)` then `f.prank(who, fn)` | `hoax(who)` without an amount gives 2^128 wei; forkit has no default, so pass one. |
| `startHoax(who, amount)` | the same, with everything inside the `prank` callback | |

Sources: [vm.deal](https://getfoundry.sh/reference/cheatcodes/deal), [forge-std deal](https://getfoundry.sh/reference/forge-std/deal), [hoax](https://getfoundry.sh/reference/forge-std/hoax).

## Impersonation

| Foundry | forkit | Note |
|---|---|---|
| `vm.prank(who)` | `await f.prank(who, async (c) => c.writeContract(...))` | `vm.prank` covers only the next call. `f.prank` covers every transaction sent through `c` until the callback settles. |
| `vm.startPrank(who)` … `vm.stopPrank()` | `await f.prank(who, async (c) => { ... })` | Impersonation stops when the callback returns or throws. Nested pranks of the same account are counted. |
| `vm.prank(who, origin)`, `startPrank(who, origin)` | none | A real transaction's `tx.origin` is its sender, so it is always `who`. |
| `vm.prank(who, true)` (delegate call) | none | forkit sends transactions, not calls from a test contract. |
| `changePrank(who)` (forge-std) | a second `f.prank` call | |

`c` is a viem client whose default account is `who`, with the same wrapping as `f.client`: writes estimate gas, wait until the state is visible, and carry a trace when they revert. `who` pays for gas like any sender, so fund it with `f.dealNative` if it has no ETH. While the callback runs, anvil accepts unsigned transactions from `who` from any client, not only from `c`.

Sources: [prank](https://getfoundry.sh/reference/cheatcodes/prank), [startPrank](https://getfoundry.sh/reference/cheatcodes/start-prank).

## Keys and signatures

| Foundry | forkit | Note |
|---|---|---|
| `makeAddrAndKey(name)` (forge-std) | `testAccount(name)` from `@condensate/forkit/payments` | A viem private-key account whose key is hashed from `name`, labelled `name`. forkit hashes in a prefix, so its keys differ from forge-std's for the same name. |
| `makeAddr(name)` (forge-std) | `testAddress(name)` | Labelled `name`. Unlike forge-std's, no one holds its key. |
| `vm.addr(privateKey)` | `privateKeyToAccount(privateKey).address` (viem) | |
| `vm.sign(privateKey, digest)` | `await account.sign({ hash: digest })` (viem) | Returns the 65-byte signature; viem's `parseSignature` splits it into `r`, `s` and `v`. For EIP-712 messages, `account.signTypedData(...)`. |
| (no equivalent) | `signPermit`, `signTransferWithAuthorization`, `signPermitTransferFrom`, `signPermitSingle` | EIP-2612, EIP-3009 and Permit2 signatures, with the domain and nonce read from the forked token. See [stablecoin payments](../guides/payments.md). |

Sources: [makeAddrAndKey](https://getfoundry.sh/reference/forge-std/make-addr-and-key), [makeAddr](https://getfoundry.sh/reference/forge-std/make-addr), [addr](https://getfoundry.sh/reference/cheatcodes/addr), [sign](https://getfoundry.sh/reference/cheatcodes/sign).

## Time and blocks

> **forkit's `warp` and `roll` are relative.** `vm.warp(t)` sets `block.timestamp` to `t`, and `vm.roll(n)` sets `block.number` to `n`. `f.warp(seconds)` moves time forward by `seconds`, and `f.roll(blocks)` mines `blocks` more blocks. `f.warp(3_600)` is forge-std's `skip(3600)`, not `vm.warp(3600)`.

| Foundry | forkit | Note |
|---|---|---|
| `skip(seconds)` (forge-std) | `await f.warp(seconds)` | `increaseTime`, then mines one block so the new timestamp is visible. The block number goes up by 1 too; `vm.warp` doesn't change it. |
| `vm.warp(timestamp)` | `f.client.setNextBlockTimestamp({ timestamp })` + `f.client.mine({ blocks: 1 })` | Absolute. The timestamp must be later than the latest block's; anvil rejects an earlier one. |
| `rewind(seconds)` (forge-std) | none | anvil's time only moves forward. Take `f.snapshot()` earlier and `f.revertTo` it. |
| `vm.roll(blockNumber)` | `await f.roll(blockNumber - (await f.client.getBlockNumber()))` | Absolute, forward only: `roll` throws on a negative count. |
| (relative roll) | `await f.roll(blocks)` | Mines `blocks` blocks; `roll(0)` does nothing. |
| `vm.getBlockTimestamp()`, `vm.getBlockNumber()` | `(await f.client.getBlock()).timestamp`, `f.client.getBlockNumber()` | |

Two things behave differently from Foundry because anvil mines real blocks:

- anvil's block timestamps also follow the wall clock. `f.warp(n)` moves the timestamp by at least `n` seconds, and sometimes a few more. Use `setNextBlockTimestamp` when a test needs an exact value.
- `f.roll(n)` mines blocks, and their timestamps follow anvil's clock too. `vm.roll` changes only `block.number`. To space the blocks out, call `f.client.mine({ blocks, interval })` yourself.

```ts
// vm.warp(1_900_000_000): an exact timestamp on the next block
await f.client.setNextBlockTimestamp({ timestamp: 1_900_000_000n });
await f.client.mine({ blocks: 1 });

// vm.roll(30_000_000): an exact block number, forward only
await f.roll(30_000_000n - (await f.client.getBlockNumber()));
```

Sources: [warp](https://getfoundry.sh/reference/cheatcodes/warp), [roll](https://getfoundry.sh/reference/cheatcodes/roll), [skip](https://getfoundry.sh/reference/forge-std/skip), [rewind](https://getfoundry.sh/reference/forge-std/rewind).

## Snapshots

| Foundry | forkit | Note |
|---|---|---|
| `vm.snapshotState()` (was `vm.snapshot()`) | `const id = await f.snapshot()` | anvil's `evm_snapshot`. |
| `vm.revertToState(id)` (was `vm.revertTo(id)`) | `await f.revertTo(id)` | **anvil consumes the snapshot**, and every later one. Foundry's `revertToState` keeps it. Take a new snapshot to revert again; reverting to a consumed id throws. |
| `vm.revertToStateAndDelete(id)` | `await f.revertTo(id)` | Every forkit revert deletes. |
| `vm.deleteStateSnapshot(id)`, `deleteStateSnapshots()` | none | Not needed. |

In a multi-chain fork, `f.snapshot()` covers only the selected chain. Snapshot each handle in `f.forks` to cover them all, as `describeFork` does.

Source: [state snapshots](https://getfoundry.sh/reference/cheatcodes/state-snapshots).

## Per-test isolation

| Foundry | forkit | Note |
|---|---|---|
| `setUp()`, run before each test | `beforeAll` inside a `describeFork` body | It runs once, after the fork boots. forkit snapshots every chain before each test and reverts after it, so every test starts from what `beforeAll` left. |
| per-test setup | `beforeEach` inside a `describeFork` body | Runs after forkit's snapshot, so its changes are undone after each test too. |
| each test starts clean | `describeFork` default | One anvil per `describeFork`, not per test. `{ isolate: false }` turns the snapshot/revert off. |
| (no equivalent) | `describeFork(..., { shared: true })` + `startSharedForks()` in a global setup | One fork for every test file. Files take turns on it, and each one reverts it before handing it on. |

Tests in one `describeFork` share a fork, so don't use `describe.concurrent` / `test.concurrent` inside it.

Source: [writing tests](https://getfoundry.sh/forge/writing-tests) ("`setUp()` runs before each test").

## Assertions

`expectRevert`, `expectEmit` and `expectBalanceChange` come from `@condensate/forkit`. They throw `ForkitAssertionError` in any runner.

### Reverts

| Foundry | forkit | Note |
|---|---|---|
| `vm.expectRevert()` | `await expectRevert(promise)` | Any revert. Resolves to the decoded revert (`kind`, `reason`, `errorName`, `args`, ...). |
| `vm.expectRevert("reason")` | `await expectRevert(promise, "reason")` | Exact match against `Error(string)`. |
| `vm.expectRevert(Err.selector)` | `expectRevert(promise, "Err(address,uint256)")` or `expectRevert(promise, "0x1234abcd")` | Compares only the selector, whatever the arguments, like `vm.expectPartialRevert`. |
| `vm.expectPartialRevert(Err.selector)` | the same | |
| `vm.expectRevert(abi.encodeWithSelector(Err.selector, a, b))` | `expectRevert(promise, { abi, errorName: "Err", args: [a, b] })` | Name and every argument must match. |
| `vm.expectRevert(bytes(""))` | `(await expectRevert(promise)).kind === "empty"` | A revert with no data. |
| (no equivalent) | `expectRevert(promise, /regex/)` | Matches the reason or the decoded description, e.g. `/division or modulo by zero/` for a panic. |
| `vm.expectRevert(bytes, reverter)` | none | forkit doesn't check which contract reverted. The trace attached to the error shows it. |
| `vm.expectRevert(bytes, count)` | none | One assertion per call. |

Foundry checks "the next call", which with nested calls can be an inner one. forkit takes the promise of the exact call, so that can't happen.

A reverting write normally rejects at gas estimation. If you pass `gas` explicitly, anvil mines the reverted transaction instead. Then pass the receipt promise and `{ client: f.client }`, so forkit can trace the transaction to find the revert data.

```ts
import { expectRevert } from "@condensate/forkit";

await f.prank(alice, async (c) => {
  await expectRevert(
    c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value: 0n }),
    "Vault: zero deposit",
  );
  await expectRevert(
    c.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [alice, 5n] }),
    { abi: vaultAbi, errorName: "InsufficientBalance", args: [alice, 0n, 5n] },
  );
});
```

### Events

| Foundry | forkit | Note |
|---|---|---|
| `vm.expectEmit()`; `emit E(...)`; call | `expectEmit(receipt, eventAbi, args)` | Checks the receipt after the fact. The event is matched by its ABI, so topic 0 is always checked. |
| `expectEmit(checkTopic1, checkTopic2, checkTopic3, checkData)` | pass only the fields to compare in `args` | A partial match, per field by name rather than per topic, with addresses compared case-insensitively. |
| `vm.expectEmit(emitter)` | `expectEmit(receipt, eventAbi, args, { address: emitter })` | |
| several `expectEmit`s in order | several `expectEmit` calls | Each call is independent; forkit does not check the order of events. |
| (no equivalent) | `{ count: n }` | Exactly `n` matching logs. By default at least one must match. |

`expectEmit` returns the matching decoded logs. Get the receipt with `f.client.waitForTransactionReceipt({ hash })`.

```ts
import { getAbiItem } from "viem";
import { expectEmit } from "@condensate/forkit";

const receipt = await f.client.waitForTransactionReceipt({ hash });
expectEmit(receipt, getAbiItem({ abi: vaultAbi, name: "Deposited" }), { account: alice }, { address: vault });
```

### Balance changes

Foundry has no cheatcode for this; a Solidity test reads `balanceOf` before and after.

| forkit | Note |
|---|---|
| `await f.expectBalanceChange(token, holder, delta, fn)` | Exact change, negative for a decrease, on the selected chain. Resolves to what `fn` resolved to. |
| `await f.expectBalanceChange(NATIVE, holder, delta, fn)` | The native balance, including any gas `holder` paid. |
| `expectBalanceChange(client, token, holder, delta, fn)` | The standalone form, for any client. |

Sources: [expectRevert](https://getfoundry.sh/reference/cheatcodes/expect-revert), [expectEmit](https://getfoundry.sh/reference/cheatcodes/expect-emit).

## Debugging

| Foundry | forkit | Note |
|---|---|---|
| `vm.label(addr, "name")` | `f.label(addr, "name")` or `label(addr, "name")` | Shows in assertion errors and traces. Labels are process-wide and apply on every chain. |
| `vm.getLabel(addr)` | `labelOf(addr)` | |
| `-vvv` (traces for failing tests) | `traces: "on-failure"`, the default | When `sendTransaction`, `writeContract` or `deployContract` reverts, forkit replays it with `debug_traceCall` and appends the decoded call tree to the error. `traceOf(error)` returns it. Reads such as `readContract` don't get one. |
| `-vvvv` (traces for all tests) | `await f.trace(hash)` | The same rendering for any mined transaction, one at a time. There is no global switch. |
| `-vvvvv` (storage changes) | none | |
| (no equivalent) | `traces: "off"` or `FORKIT_TRACES=off` | Turns the replay off. |

Traces and errors decode against the ERC-20 ABI, every ABI passed to `writeContract`, `deployContract` or `expectRevert`, and anything given to `registerAbi(abi)`. A call to a contract whose ABI forkit hasn't seen shows as its raw selector.

Sources: [label](https://getfoundry.sh/reference/cheatcodes/label), [writing tests](https://getfoundry.sh/forge/writing-tests) (verbosity levels).

## Gas snapshots

| Foundry | forkit | Note |
|---|---|---|
| `forge snapshot` | `await f.gasSnapshot("label", tx)` in `write` mode (the default outside CI) | forge records the gas of each test. forkit records one labelled transaction's `gasUsed`, which is closer to `snapshotGasLastCall`. `tx` is a hash, a receipt, a promise of either, or a function returning one. |
| `forge snapshot --check` | `gasSnapshot: "check"` or `FORKIT_GAS_SNAPSHOT=check`, the default when `CI` is set | forge exits 1 on any mismatch. forkit fails the test making the `gasSnapshot` call, on a changed or a missing entry, e.g. `gas for "deposit" changed: 51234 → 53012, +1778 (+3.47%)`. |
| `FORGE_SNAPSHOT_CHECK=true` | `FORKIT_GAS_SNAPSHOT=check` | |
| `--snap <file>` | `gasSnapshotFile` or `FORKIT_GAS_SNAPSHOT_FILE` | Default `.gas-snapshot` in the working directory, one `label (gas: N)` line each, sorted. |
| `--diff` | none | In `check` mode, each failure prints its own delta. |
| `--tolerance <pct>` | none | forkit compares exactly. |
| (no equivalent) | `gasSnapshot: "off"` | Measures and returns the gas, touching no file. |

In `write` mode, forkit adds and updates entries but never removes one. To drop labels that no longer run, delete the file and record again. forkit's numbers are real receipt gas, including the 21,000 base cost and calldata, so they don't compare with forge's per-test figures.

Sources: [forge snapshot](https://getfoundry.sh/forge/reference/forge-snapshot/), [snapshotGas cheatcodes](https://getfoundry.sh/cheatcodes/gas-snapshots).

## RPC cache

| Foundry | forkit | Note |
|---|---|---|
| fork data cached in `~/.foundry/cache/rpc/<chain>/<block>/` | `.forkit-cache/<chainId>/<block>.json` in the working directory | A recording proxy between anvil and the RPC. Pinned forks only. Set the directory with `cacheDir` or `FORKIT_CACHE_DIR`. |
| (no equivalent) | `cache: "readwrite"` (default) | Replays hits, fetches and records misses. |
| (no equivalent) | `cache: "readonly"` | Replays hits and fetches misses, but never writes. |
| (no equivalent) | `cache: "offline"`, or `FORKIT_CACHE=offline` in CI | Replays hits and fails misses loudly: no network, no RPC key. Commit the recording, or restore it with `actions/cache`. |
| `rm -rf ~/.foundry/cache/rpc` | delete the recording file | A plain `readwrite` run only adds entries it is missing. |
| (no equivalent) | `cache: "off"` | No proxy: anvil talks to the RPC directly and uses its own default caching. |
| (no equivalent) | `f.cacheStats()`, `FORKIT_DEBUG=1` | Hits and misses per method; the debug variable logs every miss. |

While forkit's proxy is in use, anvil's own disk cache is turned off, so every request reaches the recording.

Source: [fork testing](https://getfoundry.sh/forge/fork-testing).

## Other state cheats, through `f.client`

These come from viem's test actions, which are part of the fork client.

| Foundry | forkit | Note |
|---|---|---|
| `vm.store(addr, slot, value)` | `f.client.setStorageAt({ address, index: slot, value })` | `value` is a 32-byte hex word. |
| `vm.load(addr, slot)` | `f.client.getStorageAt({ address, slot })` | |
| `vm.etch(addr, code)` | `f.client.setCode({ address, bytecode })` | Runtime bytecode; no constructor runs. |
| `vm.setNonce(addr, n)` | `f.client.setNonce({ address, nonce })` | |
| `vm.getNonce(addr)` | `f.client.getTransactionCount({ address })` | |

Sources: [store](https://getfoundry.sh/reference/cheatcodes/store), [load](https://getfoundry.sh/reference/cheatcodes/load), [etch](https://getfoundry.sh/reference/cheatcodes/etch), [setNonce](https://getfoundry.sh/reference/cheatcodes/set-nonce).

## No forkit equivalent yet

| Foundry | Closest workaround |
|---|---|
| `vm.mockCall` / `clearMockedCalls` | None per calldata. `f.client.setCode` replaces a contract's whole code with a stub you compile (like `vm.etch`). For off-chain quote APIs, `@condensate/forkit/http` records and replays HTTP. |
| `vm.expectCall` | Trace the transaction and check the call tree: read `await f.trace(hash)`, or request `debug_traceTransaction` with `{ tracer: "callTracer" }` and walk the frames (the `CallFrame` type is exported). |
| `vm.assume`, fuzz tests, `bound`, invariant tests | forkit has no fuzzer. Use a property-testing library such as fast-check, or the runner's `test.each`, and keep each run small, because every case forks real state. |
| `vm.warp` / `vm.roll` backwards, `rewind` | `f.snapshot()` before, `f.revertTo(id)` after. |
| `vm.rollFork`, `createFork(url, txHash)` | Boot another `fork()` at the block you need. |
| `vm.prank` with a separate `tx.origin`, or on delegate calls | None: every forkit transaction is a real top-level transaction. |
| `expectRevert` with `reverter` or `count` | Check the attached trace (`traceOf(error)`) for which contract reverted. |
| `expectEmit` ordering | Compare the `logIndex` of the logs each `expectEmit` returns. |
| `deal(token, who, amount, true)` (adjust `totalSupply`) | None. |
| `-vvvvv` storage changes | None. |
| `forge snapshot --diff`, `--tolerance` | None. |

```ts
import type { CallFrame } from "@condensate/forkit";

// A stand-in for vm.expectCall: did the transaction call `target` with this selector?
// viem's anvil schema doesn't type debug_traceTransaction, hence the untyped request.
const request = f.client.request as (args: { method: string; params: unknown[] }) => Promise<unknown>;
const root = (await request({
  method: "debug_traceTransaction",
  params: [hash, { tracer: "callTracer" }],
})) as CallFrame;
const calls = (frame: CallFrame): CallFrame[] => [frame, ...(frame.calls ?? []).flatMap(calls)];
const called = calls(root).some(
  (c) => c.to?.toLowerCase() === target.toLowerCase() && c.input.startsWith(selector),
);
```
