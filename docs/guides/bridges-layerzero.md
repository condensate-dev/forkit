# `bridge.oft(f, { ofts })`: LayerZero v2 OFT

`bridge.oft` watches the OFTs you name for `OFTSent` and delivers each transfer on the destination fork, the way LayerZero's executor does once the message is verified.

```ts
import { bridge } from "@condensate_dev/forkit/bridges";

const f = await fork([{ chain: base, blockNumber: B }, { chain: optimism, blockNumber: O }]);
const oft = bridge.oft(f, { ofts: { [base.id]: OFT_ON_BASE } });

await sendOnBase();                  // your code: OFT.send({ dstEid: 30111, to, amountLD, ... })
const [fill] = await oft.settle();   // the OFT on OP Mainnet credited `to`
fill.outputAmount;                   // amountReceivedLD from the destination's OFTReceived
```

## How a delivery works

1. **Find the message.** `OFTSent(guid, dstEid, fromAddress, amountSentLD, amountReceivedLD)` does not name the recipient. The simulator reads the origin transaction's receipt and finds the endpoint's `PacketSent` with the same guid. Its payload is a v1 packet: version, nonce, srcEid, sender, dstEid, receiver, guid, then the OFT message (sendTo, amountSD, then the compose part, if any).
2. **`lzReceive`.** The destination OFT is the packet's receiver. The simulator reads its `endpoint()`, impersonates that endpoint, and calls `lzReceive(origin, guid, message, executor, "")`. The OFT then credits the recipient itself: it mints, or an OFT adapter unlocks. This is the OFT's real code, so its peer check runs too: the destination OFT must have the origin OFT as its peer.
3. **`lzCompose`.** If the delivery queued a compose (`ComposeSent` on the endpoint), the simulator calls `lzCompose` on the endpoint as the executor, with the exact message queued. The composer's real code runs.

What it does not do:

- **No DVN or message library verifies the packet.** `lzReceive` is called directly on the OApp, so the endpoint's inbound nonce is not advanced.
- **The endpoint gets gas money for the call, and its balance is put back after.** No native value is sent with `lzReceive` or `lzCompose`, so an `lzReceive` or `lzCompose` option that asks for `msg.value` is not honoured.
- **A transfer to a non-EVM chain**, or one whose recipient is not an EVM address, fails loudly. A transfer to an eid with no chain id fails. Without `maxFillAttempts` it holds the transfers behind it. To let a stack go on, map that eid in `eids` to a chain id you do not fork, and pass `unforkedDestination: "skip"` or `"deliver"`.

A delivery whose `lzReceive` ran and whose compose failed is retried by the next `settle()`. The retry does not call `lzReceive` again, unless an `evm_revert` undid it, so the recipient is not credited twice.

## Options

| Option | Default | |
| --- | --- | --- |
| `ofts` | required | `{ [originChainId]: address \| address[] }`: the OFTs or OFT adapters to watch. |
| `eids` | `LAYERZERO_EIDS` | `{ [chainId]: eid }`, merged. Each eid is one chain. |
| `executor` | `OFT_DEFAULT_EXECUTOR` | Who calls `lzCompose`. It is passed to `lzReceive` too. |
| `journalDir`, `maxFillAttempts`, `unforkedDestination` | | see [the long-running stack guide](long-running-stacks.md#the-fill-journal) |

A journal file is named by the message guid: `oft-<guid>.json`.

## Sources

The events, the packet layout and the calls come from [LayerZero-Labs/LayerZero-v2](https://github.com/LayerZero-Labs/LayerZero-v2): `OFTCore.sol`, `OFTMsgCodec.sol`, `OFTComposeMsgCodec.sol`, `EndpointV2.sol`, `MessagingComposer.sol` and `PacketV1Codec.sol`. The `OFTSent` topic was checked against live Base logs.

The endpoint ids come from LayerZero's [deployed contracts](https://docs.layerzero.network/v2/deployments/deployed-contracts) page. Each was checked on chain in November 2026: `eid()` of the EndpointV2 at `0x1a44076050125825900e736c501f859c50fE728c`.

| Chain | Id | eid |
| --- | --- | --- |
| Ethereum | 1 | 30101 |
| BNB Smart Chain | 56 | 30102 |
| Avalanche C-Chain | 43114 | 30106 |
| Polygon PoS | 137 | 30109 |
| Arbitrum One | 42161 | 30110 |
| OP Mainnet | 10 | 30111 |
| Base | 8453 | 30184 |

## Tests

`test/anvil/bridges-oft.vitest.ts` runs on two local anvils, with stub endpoint, OFT and composer contracts that follow the public packet and message layout. There is no recorded e2e against a real OFT yet.
