# `bridge.across`: the Across relayer simulator

`bridge.across(f)` lets a test run an Across route end to end on a multi-chain fork, with no live relayer. It watches each origin fork's Across SpokePool for deposits. On `settle()` it fills each deposit on the destination fork the way an Across relayer does. The destination SpokePool then pays the recipient, and runs any message handler, for real.

```ts
import { base, optimism } from "viem/chains";
import { fork } from "@condensate/forkit";
import { bridge } from "@condensate/forkit/bridges";

const f = await fork([
  { chain: optimism, blockNumber: 157_395_255n },
  { chain: base, blockNumber: 51_800_000n },
]);
const b = bridge.across(f); // create it before the deposit: it scans from the current head

// ... deposit into Optimism's SpokePool, e.g. from an impersonated, dealt holder ...

const [fill] = await b.settle();
fill.outputAmount; // what the recipient received on Base
fill.details; // { fee, depositOutputAmount, relayer, exclusive, repaymentChainId, spokePool, fillFunction }
```

`test/e2e/across-op-base.vitest.ts` is a complete, runnable example: an Optimism → Base USDC deposit, exclusive relayers, a message to Across's MulticallHandler, and a fee override.

## What it does

**Watching.** Every forked chain that has a known SpokePool is an origin (restrict this with `origins`). The simulator decodes two events:

- `FundsDeposited`: current SpokePools. Addresses are `bytes32` and `depositId` is `uint256`.
- `V3FundsDeposited`: SpokePools from before the bytes32 upgrade. This matters only for forks pinned at old blocks.

Both are normalised into `AcrossDepositArgs`: addresses become checksummed EVM addresses, chain ids and deposit ids become bigints, and timestamps become numbers. As with every bridge simulator, deposits made before `bridge.across(f)` was called are ignored, and deposits undone by an `evm_revert` are forgotten.

**Filling.** For each deposit, `settle()` does the following on the destination fork:

1. It checks the destination has a known SpokePool, the deposit has an output token, and `fillDeadline` has not passed at the destination fork's latest block time. Each failure is a clear error.
2. It picks the relayer. If the deposit names an `exclusiveRelayer` and `exclusivityDeadline >= latest block time`, the simulator impersonates the exclusive relayer; otherwise it uses the default relayer. The SpokePool treats the window as open while `exclusivityDeadline >= block.timestamp`, and lets the exclusive relayer fill after the window too, so leaning towards it is always safe.
3. It funds the relayer: `deal` raises its output-token balance by the amount to deliver, and it gets 10 ETH for gas if it holds less than 1 ETH.
4. It approves the SpokePool if the allowance is short. An existing non-zero allowance is zeroed first, for tokens like USDT.
5. It calls `fillRelay(relayData, repaymentChainId, repaymentAddress)`. For `V3FundsDeposited` deposits it calls `fillV3Relay(relayData, repaymentChainId)` instead.

The SpokePool pulls the output amount from the relayer and sends it to the recipient. If the output token is WETH and the recipient is an EOA, it unwraps to ETH. It then calls `handleV3AcrossMessage(token, amount, relayer, message)` on a contract recipient when the message is not empty. None of this is simulated: it is Across's own code running on the fork.

Deposits of the first watched event settle first, in the order they were seen.

## Fees and slippage

On Across the fee is set by the depositor at quote time: `fee = inputAmount - outputAmount`, and a relayer must deliver exactly `outputAmount`. The simulator reports this on every fill, in `details.fee`, as raw token units. The number is meaningful when the input and output tokens have the same decimals, like USDC → USDC.

To build a deposit with a given fee, use the helper:

```ts
import { across } from "@condensate/forkit/bridges";

const outputAmount = across.outputAmount(1_000_000_000n, { bps: 5, fixed: 20_000n });
// 1,000 USDC - (0.05 % + 0.02 USDC) = 999.48 USDC
across.fee(1_000_000_000n, { bps: 5, fixed: 20_000n }); // 520_000n
```

`fee = inputAmount * bps / 10_000 + fixed`, with the proportional part rounded down. A negative fee, or one larger than the input, throws.

To model a relayer that delivers something other than the deposit's `outputAmount` (extra fee, slippage, a bad fill), override the delivered amount:

```ts
const b = bridge.across(f, { outputAmount: (d) => d.args.outputAmount - 1_234n });
const [fill] = await b.settle();
fill.outputAmount; // quoted - 1_234
fill.details.fee; // inputAmount - (quoted - 1_234)
fill.details.depositOutputAmount; // quoted
```

(`Fill.details` is typed `Record<string, unknown>`; its shape for Across is `AcrossFillDetails`.)

The overridden amount goes into the fill's relay data. The destination SpokePool does not check fills against the origin (in production the dataworker does that off chain), so the fill lands. Its relay hash, however, is not the deposit's.

## Options

| Option | Default | |
| --- | --- | --- |
| `spokePools` | built-in table | `{ [chainId]: address }`, merged over the table. |
| `origins` | every forked chain with a SpokePool | Naming a chain with no SpokePool, or one not in the fork, throws. |
| `relayer` | `across.defaultRelayer` | Fills when no exclusive window is open. The default is derived from a hash, so no one holds its key. |
| `outputAmount` | the deposit's `outputAmount` | `(deposit) => bigint`: the amount to deliver. |
| `repaymentChainId` | the destination chain | A number, or `(deposit) => number`. It is recorded in the `FilledRelay` event. |
| `events` | `["FundsDeposited", "V3FundsDeposited"]` | Which deposit events to watch, in settle order. |

## Errors

- **No SpokePool on any forked chain**, or an `origins` entry with no SpokePool: thrown by `bridge.across(...)`. Pass `spokePools`.
- **An origin that is not forked**: thrown by `bridge.across(...)` (the core's `origin chain N is not in this fork`).
- **A deposit to a chain that is not in the fork**: `settle()` rejects with `destination chain N is not in this fork`. The deposit stays pending.
- **A destination with no known SpokePool, a deposit with no output token, or an expired fill deadline**: `settle()` rejects and names the deposit.
- **A revert in the fill itself**, such as paused fills or an already-filled relay: forkit's decoded trace is attached to the error.

## Pinning forks for Across

- **Pin the origin and destination at nearby times.** Each fork's clock starts at its pinned block. A deposit's `fillDeadline` and `exclusivityDeadline` come from the origin's clock, and the fill checks them against the destination's clock. The e2e pins Optimism 60 s before Base.
- **Use absolute exclusivity deadlines in recorded tests.** The deposit's `exclusivityParameter` can be an offset (≤ 31,536,000 s), which the SpokePool adds to the deposit block's timestamp. On a fork that timestamp follows the wall clock, so the relay hash, and the storage slot the fill reads, change from run to run and miss the offline cache. Pass an absolute timestamp (`now + 600`) instead. `fillDeadline` and `quoteTimestamp` are absolute already.
- **Public RPCs.** Optimism's and Base's public RPCs serve archive state. Arbitrum's public RPC keeps only recent state, so record Arbitrum forks with `FORKIT_RPC_URL_42161` set to an archive endpoint, or pin a recent block.

## SpokePool addresses

The built-in table (`across.spokePools`) comes from Across's docs, [Chains & Contracts](https://docs.across.to/reference/contract-addresses), which mirror [`broadcast/deployed-addresses.json`](https://github.com/across-protocol/contracts/blob/master/broadcast/deployed-addresses.json) in `across-protocol/contracts`:

| Chain | Id | SpokePool |
| --- | --- | --- |
| Ethereum | 1 | `0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5` |
| Optimism | 10 | `0x6f26Bf09B1C792e3228e5467807a900A503c0281` |
| BNB Smart Chain | 56 | `0x4e8E101924eDE233C13e2D8622DC8aED2872d505` |
| Unichain | 130 | `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64` |
| Polygon | 137 | `0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096` |
| World Chain | 480 | `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64` |
| Soneium | 1868 | `0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96` |
| Base | 8453 | `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64` |
| Arbitrum One | 42161 | `0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A` |
| Avalanche | 43114 | `0xFE9D541c92E4e90437C7152A00244886dE37a658` |
| Ink | 57073 | `0xeF684C38F94F48775959ECf2012D7E864ffb9dd4` |
| Linea | 59144 | `0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75` |

The Ethereum, Optimism, Base and Arbitrum entries were checked on chain in September 2026. Their recent logs are all `FundsDeposited`, and the implementation behind each proxy has both `fillRelay` (`0xdeff4b24`) and `fillV3Relay` (`0x2e378115`).

The ABI fragments (`spokePoolAbi` in `src/bridges/across-abi.ts`) come from [`V3SpokePoolInterface.sol`](https://github.com/across-protocol/contracts/blob/master/contracts/interfaces/V3SpokePoolInterface.sol). The fill rules described above come from [`SpokePool.sol`](https://github.com/across-protocol/contracts/blob/master/contracts/spoke-pools/SpokePool.sol).
