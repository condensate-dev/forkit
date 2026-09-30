# Assertions, traces and labels

## Assertions

The assertions work in any runner. They throw `ForkitAssertionError`, which carries `actual` and `expected` so vitest prints a diff, and they return what they matched.

```ts
import { expectBalanceChange, expectEmit, expectRevert, NATIVE } from "@condensate/forkit";

// f.client has no account: send as someone with f.prank (or pass `account`).
const deposit = (value: bigint) =>
  f.prank(alice, (c) => c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value }));
await expectRevert(deposit(0n), "Vault: zero deposit");
await expectRevert(write, "InsufficientBalance(address,uint256,uint256)");   // signature → selector
await expectRevert(write, { abi: vaultAbi, errorName: "InsufficientBalance", args: [alice, 0n, 1n] });
await expectRevert(read, /division or modulo by zero/);                       // panics too

expectEmit(receipt, depositedEvent, { account: alice });                      // partial match, any param
await f.expectBalanceChange(USDC, bob, 500_000n, () => pay(bob));             // or NATIVE; negative for a decrease
await expectBalanceChange(f.client, NATIVE, vault, -1n, () => withdraw());    // the free-function form
```

- **`expectRevert(promise, expected?, { abi?, client? })`** matches the forms below. The selector and signature forms compare the selector only, like Foundry's `expectPartialRevert`; use the `{ abi, errorName, args }` form to check arguments too. It matches:
  - a reason string (exact `Error(string)`);
  - a `RegExp`;
  - a 4-byte selector;
  - an error signature;
  - `{ abi, errorName, args }`.

  It decodes `Error(string)`, `Panic(uint256)` and custom errors, and resolves to the decoded revert. To decode a transaction that was mined with status `reverted` (sent with explicit `gas`), pass `{ client: f.client }`.
- **`expectEmit(receipt, event, args?, { address?, count? })`**: on failure, it lists every log in the receipt, decoded and labelled.
- **`expectBalanceChange`**: a native delta includes the gas the holder paid.

A mismatch reads like this, followed by the trace:

```
expected Error("Vault: zero deposit"), got InsufficientBalance(alice (0x0000…11cE), 0, 1)
```

### expectRevert and failed requests

A revert is what the node says it is: revert data, or JSON-RPC error code 3 (geth's -32000 `execution reverted` too). Any other code means the request failed, and `expectRevert` throws `expected a revert, but the call failed another way: …` with the node's message. That covers anvil's -32603 when the fork cannot fetch state, such as a miss in the [offline fork cache](fork-cache-and-ci.md), a rate limit, and a bad parameter. It holds even when viem calls the error a `ContractFunctionRevertedError`, as it does for a -32603 in a read or a gas estimate.

An exceptional halt (out of gas, the `INVALID` opcode) is not a revert either: anvil reports it with its own code (-32603 on anvil 1.7, -32003 on 1.8). To expect one, assert on the rejection itself, e.g. `await expect(write).rejects.toThrow(/OutOfGas/)`. A transaction mined with status `reverted` (explicit `gas`) always counts, however it failed.

## Traces on failure

When `sendTransaction`, `writeContract` or `deployContract` on a fork client reverts, forkit replays the call with `debug_traceCall` and appends the decoded call tree to the error. The trace is also available as `traceOf(error)`:

```
[29461] Vault::audit(5)
  ├─ [2810] Ledger::check(5) [staticcall]
  │   └─ ← [Revert] Error("Ledger: not enough entries")
  └─ ← [Revert] Error("Ledger: not enough entries")
```

`f.trace(hash)` renders any mined transaction the same way.

Calls, return values, custom errors and events decode against known ABIs:
- ERC-20;
- every ABI passed to `writeContract`, `deployContract` or `expectRevert`;
- anything you `registerAbi(abi)`.

Turn traces off with `traces: "off"` or `FORKIT_TRACES=off`.

## Labels

`label(address, "USDC")` (or `f.label`) names an address in every error and trace, like Foundry's `vm.label`. Labels are process-wide.

## How writes behave

- **Gas:** unless you pass `gas`, fork-client writes estimate gas first and send with it, as a real node does. On anvil, an impersonated transaction that reverts would otherwise be mined silently, and you would only get a hash.
- **Read-after-write:** with automine on, a write returns only once its state is visible, so the next read sees it.
- **Mining a revert on purpose:** pass an explicit `gas`. Then `expectRevert(receiptPromise, …, { client: f.client })` decodes it from the trace.
- **Automine off:** the estimate runs against `latest`, so a transaction that depends on another one still pending fails at estimation. Pass `gas` for it.
