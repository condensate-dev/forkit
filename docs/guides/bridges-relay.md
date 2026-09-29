# `bridge.relay(f)`: a simulated Relay solver

`bridge.relay` runs on a multi-chain fork (`fork([base, optimism])`). It watches Relay's deposit contract on the origin forks. On `settle()`, an impersonated, funded solver fills each deposit on its destination fork: it pays the recipient, then runs the order's calls, if any. The recipient's balance and the calls' effects land for real, and no live solver or quote API is involved.

Code: `packages/forkit/src/bridges/relay.ts` (simulator), `relay-plan.ts` (pure logic: decoding, quotes, fees), `relay-contracts.ts` (addresses and ABIs, with sources).

## What a Relay deposit looks like on-chain

Relay quotes today deposit into the **RelayDepository**. It sits at `0x4cd00e387622c35bddb9b4c962c136462338bc31` on Ethereum, Optimism, Base and Arbitrum ([addresses](https://docs.relay.link/references/protocol/depository/addresses), [contract](https://docs.relay.link/references/protocol/contracts/evm-depository), [source](https://github.com/relayprotocol/relay-depository), verified on [Basescan](https://basescan.org/address/0x4cD00E387622C35bDDB9b4c962C136462338BC31)).

| Deposit | Call | Event |
| --- | --- | --- |
| Native | `depositNative(address depositor, bytes32 id)` | `RelayNativeDeposit(address from, uint256 amount, bytes32 id)` |
| ERC-20 | `depositErc20(address depositor, address token, uint256 amount, bytes32 id)` | `RelayErc20Deposit(address from, address token, uint256 amount, bytes32 id)` |

- No event argument is indexed, so the id is read from the log data.
- The `bytes32 id` is the quote's **`protocol.v2.orderId`**, not its `requestId` ([orderId vs. requestId](https://docs.relay.link/references/protocol/guides/for-apps)).
- In a quote's deposit step, the id is also the last 32 bytes of the calldata.
- The deposit only escrows funds. Nothing on-chain says what the solver owes. That lives in the order, `protocol.v2.orderData.output` in the quote: payments (`recipient`, `currency`, `minimumAmount`, `expectedAmount`), `calls`, and `extraData`.

The older **RelayReceiver** at `0xa5f565650890fba1824ee0f21ebbbf660a179934` ([source](https://github.com/relayprotocol/relay-periphery/blob/main/src/receiver/RelayReceiver.sol)) is still deployed. It forwards `msg.value` to its solver and emits `FundsForwardedWithData(bytes data)`, where `data` is the forwarded calldata. The event carries no amount, so the simulator takes the transaction's value when the receiver was called directly. Current quotes no longer target it: it emitted no events on Base across the 10,000 blocks before 51,906,802. So it is watched only with `receiver: true`.

Not simulated: legacy deposits made as plain transfers to a solver EOA with the id appended to the calldata, and deposit addresses (those sweep into the depository, so their sweep is seen as a normal depository deposit).

## API

```ts
import { bridge } from "@condensate/forkit/bridges";

const b = bridge.relay(f, { fee: { bps: 10 } }); // options below

// Say how to fill each order: by hand ...
b.expect(orderId, {
  destinationChainId: optimism.id,
  recipient: bob,
  currency: USDC_OPTIMISM, // or bridge.relay.NATIVE
  // amount: 990_000n,     // exact output; or ({ inputAmount }) => ...; default inputAmount - fee
  // minimumAmount: ...,   // the fill refuses to pay less (slippage floor)
  // fee: 20_000n,         // overrides the simulator's fee for this fill
  // calls: [{ to, data, value }], // run through Relay's router after the payment
});
// ... or from a Relay quote response (recorded or live): reads protocol.v2.orderData.output
const id = b.expectQuote(quote); // registers the orderId (and the requestId)

// The app makes its deposit on the origin fork, e.g. depositErc20(user, USDC_BASE, amount, orderId)
const fills = await b.settle();
fills[0].outputAmount; // what the recipient got
fills[0].details;      // { orderId, kind, solver, depositor, inputToken, inputAmount, recipient,
                       //   currency, outputAmount, fee?, minimumAmount?, calls, router? }
```

Options (`bridge.relay(f, options)`):

| Option | Default | Meaning |
| --- | --- | --- |
| `solver` | a fixed address derived from `keccak256("forkit relay solver")` | who fills; impersonated and funded on the destination |
| `fee` | `0n` | fee for fills that use the default `inputAmount - fee` rule: `bigint`, or `{ bps, fixed? }` |
| `fills` | none | `{ [id]: fill }`, same as calling `b.expect` for each |
| `quotes` | none | quote responses, same as calling `b.expectQuote` for each |
| `depository` | the depository on the fork's chains among 1, 10, 8453 and 42161 | `{ [chainId]: address }` to watch instead |
| `receiver` | `false` | `true` also watches the RelayReceiver; or pass a map |
| `router` | RelayRouterV3 on 1, 10, 8453 and 42161 | `{ [chainId]: address }` of the router that runs calls |

Helpers on `bridge.relay`: `fillFromQuote(quote)`, `NATIVE`, `DEPOSITORY`, `RECEIVER`, `ROUTER`, `depositoryAbi`, `receiverAbi`.

## How a fill works

For each deposit, in chain, block and log order:

1. **Find the order.** The deposit's id (orderId, or the receiver's data) is looked up among the registered fills. An unknown id makes `poll()`/`settle()` reject with a `RelayFillError` that names the id and the chain. The deposit stays unread until a fill is registered, so a later `settle()` picks it up.
2. **Compute the amounts.**
   - The output is `amount` if the fill sets it (a number, or a function of the deposit). Otherwise it is `inputAmount - fee`, with the fill's `fee` or the simulator's.
   - `details.fee` is reported only for the fee rule. When the fill sets its own amount, input and output may be different assets, so no fee is reported.
   - A fee above the deposit, or an output below `minimumAmount`, throws, as a solver would not fill it.
3. **Fund the solver** on the destination: `dealNative` for native payouts, plus 1 ETH for gas; `deal` for ERC-20 payouts, on top of what it already holds.
4. **Pay**, from the impersonated solver: a native transfer, or an ERC-20 `transfer`, to the recipient.
5. **Run the calls** through Relay's **RelayRouterV3** `multicall(calls, refundTo, nftRecipient, metadata)`. That is `0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f` on these four chains ([source](https://github.com/relayprotocol/relay-periphery/blob/main/src/RelayRouter.sol), verified on [Arbiscan](https://arbiscan.io/address/0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f)), and it runs each call with itself as `msg.sender`, as in the real flow:
   - Relay's quotes for orders with calls pay the router: `extraData` is `(address fillContract)` = the router ([settlement SDK](https://github.com/relayprotocol/relay-settlement/blob/main/packages/sdk/src/order/index.ts)).
   - Relay's [call-execution guide](https://docs.relay.link/references/api/api_guides/calling-integration-guide) describes the destination call's caller as "Relay's router in a Relay deposit flow".
   - When the recipient is the router and the payout is native, the payment rides along as the multicall's value and funds the calls' values.
   - Otherwise the solver sends the calls' values itself.
   - Leftover native currency is refunded by the router to `refundTo`, which defaults to the depositor.
   - Order calls are decoded as `abi.encode((address to), (bytes data), (uint256 value))`, the settlement SDK's `encodeOrderCall`.

Fills without calls are direct transfers from the solver. The real solver's own contracts and the settlement on Relay Chain are not simulated. Neither is the depository's `execute` withdrawal: deposits stay escrowed in the origin depository, where tests can assert on them.

## Tests

- `test/unit/relay.vitest.ts` covers, with no network:
  - deposit decoding and id handling;
  - fill planning, fees and slippage;
  - reading a real (trimmed) quote response;
  - the unknown-id and missing-chain errors, against a stub fork.
- `test/e2e/relay-base-optimism.vitest.ts` forks Base at block 51,900,000 and Optimism at block 157,490,000. It covers:
  - USDC `depositErc20` on Base, paid on Optimism minus a bps + fixed fee;
  - ETH `depositNative` with a quote-shaped order: the router wraps it to WETH and transfers it on;
  - fill order, and an unknown id failing and then filling once registered;
  - an opt-in RelayReceiver `forward`.

  It is recorded in `packages/forkit/.forkit-cache/relay` and replays offline. The route lands on Optimism because Arbitrum's public RPC serves no historical state.
