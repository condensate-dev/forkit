/**
 * `bridge.acrossPrefunded(f, { adapters })`: a simulator for Across prefunded orders (the Across
 * v5 intents flow).
 *
 * On the origin chain the order's funds go into Across's PrefundedAdapter with
 * `store(bytes32 witness, address token, uint256 amount)`, which emits
 * `PrefundingStored(bytes32 indexed witness, address token, uint256 amount)`. The witness is the
 * order id. Native currency sent along is credited under the zero address, with its own event.
 * Source: the contract verified as `PrefundedAdapter` on Basescan,
 * https://basescan.org/address/0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94#code (checked in
 * November 2026; topic0 0x5d48f46b5dc16d228768bab74bb2e371f21c82004e9fadc08ce039cfe89304c5).
 *
 * The event does not say what the order pays on the destination. So, as with `bridge.relay`, the
 * caller registers it for each order id: `b.expect(orderId, { destinationChainId, token, amount,
 * recipient })`. On `settle()` an impersonated, funded relayer pays the recipient on the
 * destination fork. See docs/guides/bridges-across.md.
 */
import {
  type Address,
  erc20Abi,
  getAddress,
  type Hex,
  isAddressEqual,
  isHex,
  parseAbi,
  parseAbiItem,
  parseEther,
  zeroAddress,
} from "viem";
import { ForkitError } from "../errors.ts";
import type { Fork } from "../types.ts";
import { ACROSS_DEFAULT_RELAYER } from "./across.ts";
import {
  type BridgeSimulator,
  type BridgeSimulatorOptions,
  custom,
  type Deposit,
  type FillContext,
  type FillResult,
  handleFor,
  type MultiFork,
  pickSimulatorOptions,
} from "./core.ts";

/**
 * Across's PrefundedAdapter on Base, the one address forkit has checked (verified on Basescan,
 * see above). For another chain, take the address from Across's docs and pass it in `adapters`.
 */
export const ACROSS_PREFUNDED_ADAPTER_BASE: Address = "0x794dBdbDBFd3f8A3b887F4513bf5FF29edD04a94";

export const acrossPrefundingStoredEvent = parseAbiItem(
  "event PrefundingStored(bytes32 indexed witness, address token, uint256 amount)",
);

/** The adapter's deposit function and ledger, for tests and callers that prefund by hand. */
export const acrossPrefundedAdapterAbi = parseAbi([
  "function store(bytes32 witness, address token, uint256 amount) payable",
  "function storedFunding(bytes32 witness, address token) view returns (uint256 amount)",
  "event PrefundingStored(bytes32 indexed witness, address token, uint256 amount)",
]);

/** A decoded `PrefundingStored` event. */
export interface AcrossPrefundedArgs {
  /** The order id (the event's `witness`), lower-case. */
  orderId: Hex;
  /** The token stored on the origin. The zero address is native currency. */
  token: Address;
  amount: bigint;
}

/** What an order pays on the destination. */
export interface AcrossPrefundedOrder {
  destinationChainId: number;
  /** The token to pay. The zero address is native currency. */
  token: Address;
  amount: bigint;
  recipient: Address;
}

/** What `bridge.acrossPrefunded` reports in each fill's `details`. */
export interface AcrossPrefundedFillDetails {
  orderId: Hex;
  relayer: Address;
  inputToken: Address;
  inputAmount: bigint;
  recipient: Address;
  token: Address;
  outputAmount: bigint;
  /**
   * `true` when the order was paid for an earlier `PrefundingStored` event. This event added
   * funds to the same order, and the simulator paid nothing for it.
   */
  topUp: boolean;
}

export interface AcrossPrefundedOptions extends BridgeSimulatorOptions {
  /**
   * The PrefundedAdapter to watch, per origin chain id. forkit has no table of them: Base is
   * {@link ACROSS_PREFUNDED_ADAPTER_BASE}, and every other chain's address comes from you.
   */
  adapters: Readonly<Record<number, Address>>;
  /** Who pays on the destination (impersonated and funded). Default: Across's default relayer. */
  relayer?: Address;
  /** Orders to expect, by order id. Same as calling `b.expect` for each. */
  orders?: Readonly<Record<string, AcrossPrefundedOrder>>;
}

export interface AcrossPrefundedSimulator extends BridgeSimulator<AcrossPrefundedArgs> {
  /** The simulated relayer's address on every destination. */
  readonly relayer: Address;
  /** Expect a `PrefundingStored` event for `orderId` and say what the order pays. */
  expect(orderId: string, order: AcrossPrefundedOrder): AcrossPrefundedSimulator;
}

/** An order was not registered, or cannot be paid. */
export class AcrossPrefundedError extends ForkitError {
  override name = "AcrossPrefundedError";
}

/** Native balance the relayer gets on top of what it pays out, for gas. */
const RELAYER_GAS = parseEther("1");

/** An order id as a lower-case bytes32 key. */
function orderKey(id: string): Hex {
  if (!isHex(id, { strict: true }) || id.length !== 66) {
    throw new AcrossPrefundedError(
      `forkit: Across order id ${JSON.stringify(id)} is not a bytes32 (0x and 64 hex digits).`,
    );
  }
  return id.toLowerCase() as Hex;
}

function acrossPrefundedSimulator(
  f: MultiFork,
  options: AcrossPrefundedOptions,
): AcrossPrefundedSimulator {
  if (Object.keys(options.adapters).length === 0) {
    throw new AcrossPrefundedError(
      `forkit: bridge.acrossPrefunded needs the PrefundedAdapter of each origin chain: adapters: { [chainId]: "0x…" }. On Base it is ${ACROSS_PREFUNDED_ADAPTER_BASE}.`,
    );
  }
  const relayer = getAddress(options.relayer ?? ACROSS_DEFAULT_RELAYER);
  const orders = new Map<Hex, AcrossPrefundedOrder>();
  // The deposit that paid each order. The adapter adds up every store() of an order, and the
  // order is paid once, so a later event for it is a top-up.
  const paidBy = new Map<Hex, Deposit>();
  const topUps = new Set<string>();

  const orderOf = (args: Record<string, unknown>, origin: number): AcrossPrefundedOrder => {
    const key = orderKey(String(args.witness));
    const order = orders.get(key);
    if (order === undefined) {
      const known = [...orders.keys()];
      throw new AcrossPrefundedError(
        [
          `forkit: a PrefundingStored event on chain ${origin} carries order id ${key}, and no order is registered for it.`,
          `Register it before settle(): b.expect("${key}", { destinationChainId, token, amount, recipient }).`,
          `Registered: ${known.length === 0 ? "none" : known.join(", ")}.`,
        ].join("\n"),
      );
    }
    return order;
  };

  /** Whether the deposit that paid an order is still on its chain (no evm_revert undid it). */
  const stillOnChain = async (deposit: Deposit): Promise<boolean> => {
    const origin = handleFor(f, deposit.originChainId, "origin");
    const block = await origin.client
      .getBlock({ blockNumber: deposit.blockNumber })
      .catch(() => undefined);
    return block?.hash === deposit.blockHash;
  };

  async function onDeposit({
    deposit,
    destination,
  }: FillContext<Record<string, unknown>>): Promise<FillResult> {
    const args = decodeAcrossPrefunded(deposit.args);
    const order = orderOf(deposit.args, deposit.originChainId);
    const payer = paidBy.get(args.orderId);
    const topUp = payer !== undefined && payer.id !== deposit.id && (await stillOnChain(payer));
    const details: AcrossPrefundedFillDetails = {
      orderId: args.orderId,
      relayer,
      inputToken: args.token,
      inputAmount: args.amount,
      recipient: getAddress(order.recipient),
      token: getAddress(order.token),
      outputAmount: topUp ? 0n : order.amount,
      topUp,
    };
    if (topUp) {
      topUps.add(deposit.id);
      return { txHashes: [], outputAmount: 0n, details: { ...details } };
    }
    const txHash = await pay(destination, relayer, order);
    paidBy.set(args.orderId, deposit);
    return { txHashes: [txHash], outputAmount: order.amount, details: { ...details } };
  }

  const core = custom(f, {
    name: "across-prefunded",
    originEvent: { event: acrossPrefundingStoredEvent, address: options.adapters },
    destinationOf: (args: Record<string, unknown>, origin) =>
      orderOf(args, origin).destinationChainId,
    onDeposit,
    // An order is known by its id. A top-up gets its own file, so that it does not replace the
    // file of the payment.
    journalKey: (deposit) => {
      const id = orderKey(String(deposit.args.witness));
      return topUps.has(deposit.id) ? `${id}-top-up-${deposit.id}` : id;
    },
    ...pickSimulatorOptions(options),
  });

  const view = <T extends { address: Address; args: Record<string, unknown> }>(deposit: T) => ({
    ...deposit,
    address: getAddress(deposit.address),
    args: decodeAcrossPrefunded(deposit.args),
  });

  const simulator: AcrossPrefundedSimulator = {
    relayer,
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
    expect(orderId, order) {
      // Under "skip" and "deliver", a destination outside the fork is expected.
      if ((options.unforkedDestination ?? "reject") === "reject")
        handleFor(f, order.destinationChainId, "destination");
      getAddress(order.token);
      getAddress(order.recipient);
      if (order.amount < 0n) {
        throw new AcrossPrefundedError(
          `forkit: Across order ${orderId} pays ${order.amount}; the amount cannot be negative.`,
        );
      }
      orders.set(orderKey(orderId), order);
      return simulator;
    },
  };
  for (const [id, order] of Object.entries(options.orders ?? {})) simulator.expect(id, order);
  return simulator;
}

/** Normalise the decoded args of `PrefundingStored`. */
export function decodeAcrossPrefunded(args: Record<string, unknown>): AcrossPrefundedArgs {
  return {
    orderId: orderKey(String(args.witness)),
    token: getAddress(String(args.token)),
    amount: BigInt(args.amount as bigint),
  };
}

/** Pay the order's recipient from a funded, impersonated relayer. */
async function pay(destination: Fork, relayer: Address, order: AcrossPrefundedOrder): Promise<Hex> {
  const native = isAddressEqual(order.token, zeroAddress);
  destination.label(relayer, "AcrossRelayer (forkit)");
  const gas = await destination.client.getBalance({ address: relayer });
  await destination.dealNative(relayer, gas + (native ? order.amount : 0n) + RELAYER_GAS);
  if (!native && order.amount > 0n) {
    const held = await destination.client.readContract({
      address: order.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [relayer],
    });
    await destination.deal(order.token, relayer, held + order.amount);
  }
  return destination.prank(relayer, (c) =>
    native
      ? c.sendTransaction({ to: order.recipient, value: order.amount })
      : c.writeContract({
          address: order.token,
          abi: erc20Abi,
          functionName: "transfer",
          args: [order.recipient, order.amount],
        }),
  );
}

/**
 * Across prefunded-order simulator on a multi-chain fork.
 *
 * ```ts
 * const b = bridge.acrossPrefunded(f, { adapters: { [base.id]: ACROSS_PREFUNDED_ADAPTER_BASE } });
 * b.expect(orderId, { destinationChainId: optimism.id, token: USDC_OP, amount, recipient });
 * // ... store(orderId, USDC_BASE, amount) on Base's PrefundedAdapter ...
 * const [fill] = await b.settle(); // the recipient got `amount` USDC on Optimism
 * ```
 */
export const acrossPrefunded = Object.assign(acrossPrefundedSimulator, {
  /** The PrefundedAdapter on Base. */
  ADAPTER_BASE: ACROSS_PREFUNDED_ADAPTER_BASE,
  adapterAbi: acrossPrefundedAdapterAbi,
});
