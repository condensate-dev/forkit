/**
 * `bridge.oft(f, { ofts })`: a simulator for LayerZero v2 OFT transfers.
 *
 * On the origin chain, `send` on an OFT (or OFT adapter) emits
 * `OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD,
 * uint256 amountReceivedLD)`, and the EndpointV2 emits `PacketSent(bytes encodedPayload,
 * bytes options, address sendLibrary)` in the same transaction. The recipient is not in OFTSent:
 * it is in the packet's message. Sources, all in https://github.com/LayerZero-Labs/LayerZero-v2:
 * - `OFTCore.sol` (OFTSent, OFTReceived), `OFTMsgCodec.sol` (sendTo, amountSD, then composeFrom
 *   and the compose message), `OFTComposeMsgCodec.sol`.
 * - `EndpointV2.sol` and `MessagingComposer.sol` (PacketSent, ComposeSent, lzCompose).
 * - `PacketV1Codec.sol`: version (1 byte), nonce (8), srcEid (4), sender (32), dstEid (4),
 *   receiver (32), guid (32), then the message.
 * The OFTSent topic was checked against live Base logs in November 2026.
 *
 * On `settle()`, the simulator does what LayerZero's executor does once the message is verified:
 * it calls `lzReceive` on the destination OFT, as that OFT's endpoint (impersonated), so the OFT
 * credits the recipient itself. For a composed message it then calls `lzCompose` on the
 * destination endpoint, as an executor. No DVN verifies anything. See
 * docs/guides/bridges-layerzero.md.
 */
import {
  type Address,
  getAddress,
  type Hex,
  hexToBigInt,
  hexToNumber,
  isHex,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEther,
  parseEventLogs,
  size,
  slice,
  toHex,
} from "viem";
import { ForkitError } from "../errors.ts";
import type { Fork } from "../types.ts";
import {
  type BridgeSimulator,
  type BridgeSimulatorOptions,
  custom,
  type Deposit,
  type FailedFill,
  type Fill,
  type FillContext,
  type FillResult,
  type MultiFork,
  pickSimulatorOptions,
} from "./core.ts";

export const oftSentEvent = parseAbiItem(
  "event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)",
);
export const oftReceivedEvent = parseAbiItem(
  "event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)",
);
export const lzPacketSentEvent = parseAbiItem(
  "event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)",
);
export const lzComposeSentEvent = parseAbiItem(
  "event ComposeSent(address from, address to, bytes32 guid, uint16 index, bytes message)",
);

/** The OApp side of a delivery: who its endpoint is, and the call the endpoint makes. */
export const lzOAppAbi = parseAbi([
  "struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }",
  "function endpoint() view returns (address)",
  "function lzReceive(Origin _origin, bytes32 _guid, bytes _message, address _executor, bytes _extraData) payable",
]);

/** The endpoint calls the simulator makes. */
export const lzEndpointAbi = parseAbi([
  "function eid() view returns (uint32)",
  "function lzCompose(address _from, address _to, bytes32 _guid, uint16 _index, bytes _message, bytes _extraData) payable",
]);

/**
 * LayerZero v2 endpoint id of each chain, by chain id. Source: LayerZero's docs, "Deployed
 * Contracts" (https://docs.layerzero.network/v2/deployments/deployed-contracts). Each entry was
 * checked on chain in November 2026: `eid()` of the EndpointV2 at
 * {@link LAYERZERO_ENDPOINT_V2}.
 */
export const LAYERZERO_EIDS: Readonly<Record<number, number>> = {
  1: 30101, // Ethereum
  56: 30102, // BNB Smart Chain
  43114: 30106, // Avalanche C-Chain
  137: 30109, // Polygon PoS
  42161: 30110, // Arbitrum One
  10: 30111, // OP Mainnet
  8453: 30184, // Base
};

/** EndpointV2, at one address on every chain in {@link LAYERZERO_EIDS}. */
export const LAYERZERO_ENDPOINT_V2: Address = "0x1a44076050125825900e736c501f859c50fE728c";

/**
 * The executor the simulator acts as for `lzCompose`. Derived from a hash, so no one holds its
 * key on a real chain.
 */
export const OFT_DEFAULT_EXECUTOR: Address = getAddress(
  slice(keccak256(toHex("forkit layerzero executor")), 12),
);

/** A decoded `OFTSent` event. */
export interface OftSentArgs {
  guid: Hex;
  dstEid: number;
  fromAddress: Address;
  /** In the origin token's local decimals. */
  amountSentLD: bigint;
  amountReceivedLD: bigint;
}

export type OftDeposit = Deposit<OftSentArgs>;
export type OftFill = Fill<OftSentArgs>;
export type OftFailedFill = FailedFill<OftSentArgs>;

/** A packet as `PacketV1Codec` lays it out, and its OFT message. */
export interface OftPacket {
  nonce: bigint;
  srcEid: number;
  sender: Hex;
  dstEid: number;
  /** The destination OApp (OFT or OFT adapter). */
  receiver: Address;
  guid: Hex;
  message: Hex;
  /** The OFT message: who gets the tokens, and how many, in shared decimals. */
  sendTo: Address;
  amountSD: bigint;
  /** The compose part of the message (composeFrom, then the composer's data), if any. */
  compose?: Hex;
}

/** What `bridge.oft` reports in each fill's `details`. */
export interface OftFillDetails {
  guid: Hex;
  nonce: bigint;
  srcEid: number;
  dstEid: number;
  /** The destination OFT. */
  oft: Address;
  endpoint: Address;
  recipient: Address;
  amountSD: bigint;
  /** Whether the message had a compose part, and so an `lzCompose` call ran. */
  composed: boolean;
  executor: Address;
}

export interface OftOptions extends BridgeSimulatorOptions {
  /** The OFT (or OFT adapter) contracts to watch, per origin chain id. */
  ofts: Readonly<Record<number, Address | readonly Address[]>>;
  /** LayerZero endpoint id per chain id, merged over {@link LAYERZERO_EIDS}. */
  eids?: Readonly<Record<number, number>>;
  /** Who calls `lzCompose`. Default: {@link OFT_DEFAULT_EXECUTOR}. */
  executor?: Address;
}

/** An OFT transfer cannot be delivered. */
export class OftError extends ForkitError {
  override name = "OftError";
}

/** Gas for the impersonated endpoint and executor. */
const GAS_FUNDS = parseEther("1");

function addressIn(word: Hex, what: string): Address {
  if (BigInt(slice(word, 0, 12)) !== 0n) {
    throw new OftError(
      `forkit: LayerZero ${what} ${word} is not an EVM address in a bytes32. A transfer to a non-EVM chain cannot be delivered on a fork: map its eid in \`eids\` to a chain id that is not forked, and pass unforkedDestination: "skip" or "deliver".`,
    );
  }
  return getAddress(slice(word, 12));
}

/** Decode a `PacketSent` payload and the OFT message in it. */
export function decodeOftPacket(payload: Hex): OftPacket {
  // 113 bytes of header and guid, then at least sendTo (32) and amountSD (8).
  if (!isHex(payload) || size(payload) < 113 + 40) {
    throw new OftError(
      `forkit: a LayerZero packet of ${isHex(payload) ? size(payload) : 0} bytes is too short for an OFT message (153 bytes or more).`,
    );
  }
  const message = slice(payload, 113);
  return {
    nonce: hexToBigInt(slice(payload, 1, 9)),
    srcEid: hexToNumber(slice(payload, 9, 13)),
    sender: slice(payload, 13, 45),
    dstEid: hexToNumber(slice(payload, 45, 49)),
    receiver: addressIn(slice(payload, 49, 81), "receiver"),
    guid: slice(payload, 81, 113),
    message,
    sendTo: addressIn(slice(message, 0, 32), "sendTo"),
    amountSD: hexToBigInt(slice(message, 32, 40)),
    ...(size(message) > 40 ? { compose: slice(message, 40) } : {}),
  };
}

/**
 * The OFT packet with `guid` among the `PacketSent` payloads of one transaction, or `undefined`.
 * It matches on the guid before it decodes: the same transaction can send other LayerZero
 * messages (to another OApp, or to a non-EVM chain) that do not decode as an OFT message.
 */
export function oftPacketFor(payloads: readonly Hex[], guid: Hex): OftPacket | undefined {
  const payload = payloads.find(
    (p) => size(p) >= 113 && slice(p, 81, 113).toLowerCase() === guid.toLowerCase(),
  );
  return payload === undefined ? undefined : decodeOftPacket(payload);
}

const isHexValue = (v: unknown): v is Hex => typeof v === "string" && isHex(v);

/** Normalise the decoded args of `OFTSent`. */
export function decodeOftSent(args: Record<string, unknown>): OftSentArgs {
  const { guid, dstEid, fromAddress, amountSentLD, amountReceivedLD } = args;
  if (
    !isHexValue(guid) ||
    typeof dstEid !== "number" ||
    !isHexValue(fromAddress) ||
    typeof amountSentLD !== "bigint" ||
    typeof amountReceivedLD !== "bigint"
  ) {
    throw new OftError(
      `forkit: an OFTSent event has unexpected fields: ${JSON.stringify(Object.keys(args))}.`,
    );
  }
  return { guid, dstEid, fromAddress: getAddress(fromAddress), amountSentLD, amountReceivedLD };
}

/** Run `fn` as `account`, with gas lent for it and the native balance put back afterwards. */
async function withGas(fork: Fork, account: Address, fn: () => Promise<Hex>): Promise<Hex> {
  const balance = await fork.client.getBalance({ address: account });
  await fork.dealNative(account, balance + GAS_FUNDS);
  try {
    return await fn();
  } finally {
    // The endpoint holds no gas money on a real chain; leave its balance as it was.
    await fork.dealNative(account, balance);
  }
}

/** Whether a transaction is still on the chain (an evm_revert drops it). */
async function stillMined(fork: Fork, hash: Hex): Promise<boolean> {
  try {
    await fork.client.getTransactionReceipt({ hash });
    return true;
  } catch {
    return false;
  }
}

function oftSimulator(f: MultiFork, options: OftOptions): BridgeSimulator<OftSentArgs> {
  if (Object.keys(options.ofts).length === 0) {
    throw new OftError(
      'forkit: bridge.oft needs the OFT contracts to watch: ofts: { [chainId]: "0x…" }.',
    );
  }
  const eids: Record<number, number> = { ...LAYERZERO_EIDS, ...options.eids };
  const chainOfEid = new Map<number, number>();
  for (const [chainId, eid] of Object.entries(eids)) {
    if (chainOfEid.has(eid)) {
      throw new OftError(
        `forkit: LayerZero eid ${eid} is given to chains ${chainOfEid.get(eid)} and ${chainId}; each eid is one chain.`,
      );
    }
    chainOfEid.set(eid, Number(chainId));
  }
  const executor = getAddress(options.executor ?? OFT_DEFAULT_EXECUTOR);
  /** Deliveries that ran lzReceive and not every lzCompose yet, by lower-case guid. */
  const done = new Map<string, { receiveTx: Hex; composeTxs: Hex[] }>();

  async function onDeposit({
    deposit,
    origin,
    destination,
  }: FillContext<Record<string, unknown>>): Promise<FillResult> {
    const args = decodeOftSent(deposit.args);
    const sent = await origin.client.getTransactionReceipt({ hash: deposit.txHash });
    const packet = oftPacketFor(
      parseEventLogs({ abi: [lzPacketSentEvent], logs: sent.logs }).map(
        (log) => log.args.encodedPayload,
      ),
      args.guid,
    );
    if (packet === undefined) {
      throw new OftError(
        `forkit: OFTSent ${args.guid} in ${deposit.txHash} on chain ${deposit.originChainId} has no PacketSent with its guid in the same transaction. Is ${deposit.address} an OFT on a LayerZero v2 endpoint?`,
      );
    }
    const oft = packet.receiver;
    const endpoint = getAddress(
      await destination.client.readContract({
        address: oft,
        abi: lzOAppAbi,
        functionName: "endpoint",
      }),
    );
    destination.label(endpoint, "EndpointV2");
    destination.label(executor, "LayerZeroExecutor (forkit)");

    // A delivery whose compose failed is retried. Its lzReceive already ran and must not run
    // again, unless an evm_revert undid it.
    const earlier = done.get(packet.guid.toLowerCase());
    let receiveTx: Hex | undefined;
    if (earlier !== undefined && (await stillMined(destination, earlier.receiveTx))) {
      receiveTx = earlier.receiveTx;
    } else {
      done.delete(packet.guid.toLowerCase());
    }
    if (receiveTx === undefined) {
      try {
        receiveTx = await withGas(destination, endpoint, () =>
          destination.prank(endpoint, (c) =>
            c.writeContract({
              address: oft,
              abi: lzOAppAbi,
              functionName: "lzReceive",
              args: [
                { srcEid: packet.srcEid, sender: packet.sender, nonce: packet.nonce },
                packet.guid,
                packet.message,
                executor,
                "0x",
              ],
            }),
          ),
        );
      } catch (error) {
        throw new OftError(
          `forkit: lzReceive on ${oft} (chain ${destination.chain.id}) for guid ${packet.guid} reverted. The destination OFT must have the origin OFT ${packet.sender} as its peer for eid ${packet.srcEid} (setPeer). ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    const delivery = done.get(packet.guid.toLowerCase()) ?? { receiveTx, composeTxs: [] };
    done.set(packet.guid.toLowerCase(), delivery);
    const received = await destination.client.waitForTransactionReceipt({ hash: receiveTx });
    const credited = parseEventLogs({ abi: [oftReceivedEvent], logs: received.logs }).find(
      (log) => log.args.guid.toLowerCase() === packet.guid.toLowerCase(),
    );

    // Each ComposeSent the delivery queued is run as the executor would, in order. The ones a
    // failed attempt already ran are not run again.
    const composes = parseEventLogs({ abi: [lzComposeSentEvent], logs: received.logs }).filter(
      (log) => log.args.guid.toLowerCase() === packet.guid.toLowerCase(),
    );
    for (const compose of composes.slice(delivery.composeTxs.length)) {
      const tx = await withGas(destination, executor, () =>
        destination.prank(executor, (c) =>
          c.writeContract({
            address: compose.address,
            abi: lzEndpointAbi,
            functionName: "lzCompose",
            args: [
              compose.args.from,
              compose.args.to,
              compose.args.guid,
              compose.args.index,
              compose.args.message,
              "0x",
            ],
          }),
        ),
      );
      delivery.composeTxs.push(tx);
    }
    done.delete(packet.guid.toLowerCase());
    const txHashes: Hex[] = [receiveTx, ...delivery.composeTxs];

    const details: OftFillDetails = {
      guid: packet.guid,
      nonce: packet.nonce,
      srcEid: packet.srcEid,
      dstEid: packet.dstEid,
      oft,
      endpoint,
      recipient: packet.sendTo,
      amountSD: packet.amountSD,
      composed: packet.compose !== undefined,
      executor,
    };
    return {
      txHashes,
      ...(credited === undefined ? {} : { outputAmount: credited.args.amountReceivedLD }),
      details: { ...details },
    };
  }

  const core = custom(f, {
    name: "oft",
    originEvent: { event: oftSentEvent, address: options.ofts },
    destinationOf: (args: Record<string, unknown>) => {
      const { dstEid } = decodeOftSent(args);
      const chainId = chainOfEid.get(dstEid);
      if (chainId === undefined) {
        throw new OftError(
          `forkit: an OFT transfer goes to LayerZero eid ${dstEid}, which has no chain id. Pass eids: { [chainId]: ${dstEid} }. For a chain you do not fork, such as Solana, a chain id that is not forked works, with unforkedDestination: "skip" or "deliver".`,
        );
      }
      return chainId;
    },
    onDeposit,
    // A LayerZero message is known by its guid.
    journalKey: (deposit) => decodeOftSent(deposit.args).guid,
    ...pickSimulatorOptions(options),
  });

  const view = <T extends { address: Address; args: Record<string, unknown> }>(deposit: T) => ({
    ...deposit,
    address: getAddress(deposit.address),
    args: decodeOftSent(deposit.args),
  });

  return {
    get pending() {
      return core.pending.map(view);
    },
    get fills() {
      return core.fills.map((x) => ({ ...x, deposit: view(x.deposit) }));
    },
    get failed() {
      return core.failed.map((x) => ({ ...x, deposit: view(x.deposit) }));
    },
    poll: async () => (await core.poll()).map(view),
    settle: async () => (await core.settle()).map((x) => ({ ...x, deposit: view(x.deposit) })),
  };
}

/**
 * LayerZero v2 OFT simulator on a multi-chain fork.
 *
 * ```ts
 * const oft = bridge.oft(f, { ofts: { [base.id]: OFT_ON_BASE } });
 * // ... send() on Base's OFT to OP Mainnet's eid ...
 * const [fill] = await oft.settle(); // the OFT on OP Mainnet credited the recipient
 * ```
 */
export const oft = Object.assign(oftSimulator, {
  eids: LAYERZERO_EIDS,
  endpointV2: LAYERZERO_ENDPOINT_V2,
  defaultExecutor: OFT_DEFAULT_EXECUTOR,
});
