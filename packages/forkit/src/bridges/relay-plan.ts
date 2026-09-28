/**
 * The pure half of the Relay simulator: decoding deposits, reading fills out of Relay quotes, and
 * planning a fill (amounts, fees, calls). No RPC here, so all of it is unit-tested offline.
 *
 * Sources: Relay's docs on the order and its two ids
 * (https://docs.relay.link/references/protocol/guides/for-apps), quote validation
 * (https://docs.relay.link/references/api/api_core_concepts/input-validation), and the verified
 * contracts cited in relay-contracts.ts.
 */
import {
  type Address,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  type Hex,
  isHex,
  parseAbiParameters,
  size,
} from "viem";
import { ForkitError } from "../errors.ts";
import { RELAY_CHAIN_SLUGS, RELAY_NATIVE } from "./relay-contracts.ts";

/** A Relay fill that cannot be planned or performed: unknown order, bad amounts, missing router. */
export class RelayFillError extends ForkitError {
  override name = "RelayFillError";
}

/** Which origin contract and event a deposit came from. */
export type RelayDepositKind = "native" | "erc20" | "receiver";

/** A Relay deposit, normalized across the depository's two events and the receiver's. */
export interface RelayDepositArgs {
  kind: RelayDepositKind;
  /**
   * What ties the deposit to its order, lower-case: the depository's `bytes32 id` (the quote's
   * `protocol.v2.orderId`), or for the receiver the forwarded `data`.
   */
  id: Hex;
  /** Depositor credited by the depository (`from`); not known for receiver deposits. */
  from?: Address;
  /** Deposited token, or {@link RELAY_NATIVE}. */
  token: Address;
  /**
   * Deposited amount. For receiver deposits it is the transaction's value when the receiver was
   * called directly, and unknown (undefined) when it was called from another contract.
   */
  amount?: bigint;
}

/** A call the solver's fill runs on the destination, through Relay's router (see {@link RelayFill}). */
export interface RelayCall {
  to: Address;
  data: Hex;
  /** Native value sent with the call. Default 0. */
  value?: bigint;
}

/**
 * A fee on the deposited amount: a flat amount in the deposit's units, or basis points plus an
 * optional flat part. The output is `inputAmount - fee`.
 */
export type RelayFee = bigint | { bps: number | bigint; fixed?: bigint };

/** What a custom `amount` function sees. */
export interface RelayAmountContext {
  deposit: RelayDepositArgs;
  /** The deposited amount (undefined only for receiver deposits made through another contract). */
  inputAmount: bigint | undefined;
}

/**
 * How to fill one Relay order on its destination: what the order's output says in a real quote
 * (`protocol.v2.orderData.output`). Register it with `b.expect(orderId, fill)`, or let
 * `b.expectQuote(quote)` read it from a Relay quote response.
 */
export interface RelayFill {
  /** Destination chain id. It must be one of the fork's chains. */
  destinationChainId: number;
  /** Who is paid on the destination. With calls, Relay's quotes pay the router, which runs them. */
  recipient: Address;
  /** Output currency on the destination: an ERC-20 address, or {@link RELAY_NATIVE}. */
  currency: Address;
  /**
   * The output amount: exact, or computed from the deposit. Default `inputAmount - fee`, which
   * only makes sense when input and output are the same asset in the same units.
   */
  amount?: bigint | ((context: RelayAmountContext) => bigint);
  /** The fill refuses to pay less than this (the order's slippage floor). */
  minimumAmount?: bigint;
  /** Fee for the default amount rule; overrides the simulator's `fee` option. */
  fee?: RelayFee;
  /** Calls to run after the payment, through Relay's router `multicall` (router is `msg.sender`). */
  calls?: readonly RelayCall[];
  /** The router that runs `calls`. Default: Relay's router on the destination chain. */
  router?: Address;
  /** Where the router refunds leftover native currency after the calls. Default: the depositor. */
  refundTo?: Address;
}

/** A fill, resolved against its deposit: exactly what the solver will do. */
export interface RelayFillPlan {
  recipient: Address;
  currency: Address;
  outputAmount: bigint;
  /** The fee taken, when the output came from the fee rule (`inputAmount - fee`). */
  fee?: bigint;
  minimumAmount?: bigint;
  calls: RelayCall[];
  /** The router that runs `calls` (set whenever there are calls). */
  router?: Address;
  refundTo: Address;
}

/** A deposit or order id as a lower-case hex key. */
export function relayKey(id: string): Hex {
  if (!isHex(id, { strict: true }) || id.length <= 2) {
    throw new RelayFillError(`forkit: Relay id ${JSON.stringify(id)} is not hex data`);
  }
  return id.toLowerCase() as Hex;
}

/** Normalize the decoded args of one of Relay's deposit events. */
export function decodeRelayDeposit(
  kind: RelayDepositKind,
  args: Record<string, unknown>,
  txValue?: bigint,
): RelayDepositArgs {
  switch (kind) {
    case "native":
      return {
        kind,
        id: relayKey(args.id as Hex),
        from: getAddress(args.from as Address),
        token: RELAY_NATIVE,
        amount: args.amount as bigint,
      };
    case "erc20":
      return {
        kind,
        id: relayKey(args.id as Hex),
        from: getAddress(args.from as Address),
        token: getAddress(args.token as Address),
        amount: args.amount as bigint,
      };
    case "receiver":
      return {
        kind,
        id: relayKey(args.data as Hex),
        token: RELAY_NATIVE,
        ...(txValue === undefined ? {} : { amount: txValue }),
      };
  }
}

function feeOf(fee: RelayFee, input: bigint): bigint {
  if (typeof fee === "bigint") return fee;
  return (input * BigInt(fee.bps)) / 10_000n + (fee.fixed ?? 0n);
}

/**
 * Resolve a registered fill against its deposit: the output amount (exact, custom, or
 * `inputAmount - fee`), the slippage floor, and the calls with their router.
 */
export function planRelayFill(
  deposit: RelayDepositArgs,
  fill: RelayFill,
  defaults: { fee?: RelayFee; router?: Address } = {},
): RelayFillPlan {
  const where = `Relay order ${deposit.id}`;
  let outputAmount: bigint;
  let fee: bigint | undefined;
  if (typeof fill.amount === "bigint") {
    outputAmount = fill.amount;
  } else if (typeof fill.amount === "function") {
    outputAmount = fill.amount({ deposit, inputAmount: deposit.amount });
  } else {
    if (deposit.amount === undefined) {
      throw new RelayFillError(
        `forkit: ${where}: the deposited amount is unknown (a receiver deposit made through another contract), so the output cannot be inputAmount - fee. Set \`amount\` on the fill.`,
      );
    }
    fee = feeOf(fill.fee ?? defaults.fee ?? 0n, deposit.amount);
    if (fee < 0n || fee > deposit.amount) {
      throw new RelayFillError(
        `forkit: ${where}: fee ${fee} is outside the deposited amount ${deposit.amount}`,
      );
    }
    outputAmount = deposit.amount - fee;
  }
  if (outputAmount < 0n) {
    throw new RelayFillError(`forkit: ${where}: output amount ${outputAmount} is negative`);
  }
  if (fill.minimumAmount !== undefined && outputAmount < fill.minimumAmount) {
    throw new RelayFillError(
      `forkit: ${where}: output ${outputAmount} is below the order's minimumAmount ${fill.minimumAmount} (slippage too high); a solver would not fill it`,
    );
  }
  const calls = [...(fill.calls ?? [])];
  const router = fill.router ?? defaults.router;
  if (calls.length > 0 && router === undefined) {
    throw new RelayFillError(
      `forkit: ${where} has calls but no known Relay router on chain ${fill.destinationChainId}; pass \`router\` on the fill or in the simulator options`,
    );
  }
  return {
    recipient: getAddress(fill.recipient),
    currency: getAddress(fill.currency),
    outputAmount,
    ...(fee === undefined ? {} : { fee }),
    ...(fill.minimumAmount === undefined ? {} : { minimumAmount: fill.minimumAmount }),
    calls,
    ...(calls.length > 0 && router !== undefined ? { router: getAddress(router) } : {}),
    refundTo: getAddress(fill.refundTo ?? deposit.from ?? fill.recipient),
  };
}

/**
 * The parts of a Relay quote response (`POST https://api.relay.link/quote`) that describe the
 * fill. Structural, so a recorded or replayed response can be passed as is.
 */
export interface RelayQuoteLike {
  requestId?: string;
  steps?: readonly { requestId?: string }[];
  details?: {
    currencyOut?: { currency?: { chainId?: number } };
  };
  protocol?: {
    v2?: {
      orderId: string;
      orderData?: {
        output?: {
          chainId?: string;
          payments?: readonly {
            recipient: string;
            currency: string;
            minimumAmount?: string;
            expectedAmount?: string;
          }[];
          /** Each call is `abi.encode((address to), (bytes data), (uint256 value))`. */
          calls?: readonly string[];
          /** `abi.encode((address fillContract))`: the router that runs the calls. */
          extraData?: string;
        };
      };
    };
  };
}

/** How {@link fillFromQuote} picks the output amount. */
export interface FillFromQuoteOptions {
  /** Pay the quote's `expectedAmount` (default) or its `minimumAmount` (worst-case slippage). */
  amount?: "expected" | "minimum";
}

/**
 * Each entry of `orderData.output.calls` is `abi.encode((address to), (bytes data), (uint256 value))`:
 * three one-field tuples, as Relay's settlement SDK encodes them (`encodeOrderCall` in
 * https://github.com/relayprotocol/relay-settlement, packages/sdk/src/order/index.ts).
 */
const ORDER_CALL_PARAMS = parseAbiParameters(["(address to)", "(bytes data)", "(uint256 value)"]);

/** `orderData.output.extraData`: `abi.encode((address fillContract))`, the contract that runs the fill. */
const ORDER_EXTRA_DATA_PARAMS = parseAbiParameters(["(address fillContract)"]);

/** Decode one entry of `orderData.output.calls`. */
export function decodeRelayOrderCall(encoded: Hex): RelayCall {
  const [{ to }, { data }, { value }] = decodeAbiParameters(ORDER_CALL_PARAMS, encoded);
  return { to, data, value };
}

/** Encode a call the way Relay orders carry it (for tests and hand-built quotes). */
export function encodeRelayOrderCall(call: RelayCall): Hex {
  return encodeAbiParameters(ORDER_CALL_PARAMS, [
    { to: call.to },
    { data: call.data },
    { value: call.value ?? 0n },
  ]);
}

/**
 * Read a fill out of a Relay quote's `protocol.v2` order: the one payment (recipient, currency,
 * expected and minimum amounts), the calls and the router. Returns the ids to register it under:
 * the order id (what the depository deposit carries) and the request id, if present.
 */
export function fillFromQuote(
  quote: RelayQuoteLike,
  options: FillFromQuoteOptions = {},
): { ids: Hex[]; fill: RelayFill } {
  const v2 = quote.protocol?.v2;
  const output = v2?.orderData?.output;
  if (v2 === undefined || output === undefined) {
    throw new RelayFillError(
      "forkit: this Relay quote has no protocol.v2 order (orderId and orderData.output), so its fill is unknown; register it with b.expect(id, fill)",
    );
  }
  const payments = output.payments ?? [];
  const payment = payments[0];
  if (payment === undefined || payments.length !== 1) {
    throw new RelayFillError(
      `forkit: Relay order ${v2.orderId} has ${payments.length} output payments; the simulator reads exactly one from a quote (register other shapes with b.expect)`,
    );
  }
  const slug = output.chainId;
  const destinationChainId =
    quote.details?.currencyOut?.currency?.chainId ??
    (slug === undefined ? undefined : RELAY_CHAIN_SLUGS[slug]);
  if (destinationChainId === undefined) {
    throw new RelayFillError(
      `forkit: cannot tell the destination chain id of Relay order ${v2.orderId} (chain "${slug}"); register it with b.expect(id, fill)`,
    );
  }
  const pick = options.amount ?? "expected";
  const amount = pick === "expected" ? payment.expectedAmount : payment.minimumAmount;
  if (amount === undefined) {
    throw new RelayFillError(`forkit: Relay order ${v2.orderId} has no ${pick}Amount`);
  }
  const calls = (output.calls ?? []).map((c) => decodeRelayOrderCall(relayKey(c)));
  const extra = output.extraData;
  const router =
    extra !== undefined && isHex(extra) && size(extra) === 32
      ? decodeAbiParameters(ORDER_EXTRA_DATA_PARAMS, extra)[0].fillContract
      : undefined;
  const fill: RelayFill = {
    destinationChainId,
    recipient: getAddress(payment.recipient),
    currency: getAddress(payment.currency),
    amount: BigInt(amount),
    ...(payment.minimumAmount === undefined
      ? {}
      : { minimumAmount: BigInt(payment.minimumAmount) }),
    ...(calls.length > 0 ? { calls } : {}),
    ...(router === undefined ? {} : { router }),
  };
  const requestId = quote.requestId ?? quote.steps?.find((s) => s.requestId)?.requestId;
  const ids = [relayKey(v2.orderId)];
  if (requestId !== undefined && relayKey(requestId) !== ids[0]) ids.push(relayKey(requestId));
  return { ids, fill };
}
