/**
 * The pure half of the Relay simulator: decoding deposits, reading fills out of Relay quotes, and
 * planning a fill (amounts, fees, calls). No RPC here, so all of it is unit-tested offline.
 *
 * Sources: Relay's docs on the order and its two ids
 * (https://docs.relay.link/references/protocol/guides/for-apps), quote validation
 * (https://docs.relay.link/references/api/api_core_concepts/input-validation), and the verified
 * contracts cited in relay-contracts.ts.
 */
import { type Address, type Hex } from "viem";
import { ForkitError } from "../errors.ts";
/** A Relay fill that cannot be planned or performed: unknown order, bad amounts, missing router. */
export declare class RelayFillError extends ForkitError {
    name: string;
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
export type RelayFee = bigint | {
    bps: number | bigint;
    fixed?: bigint;
};
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
export declare function relayKey(id: string): Hex;
/** Normalize the decoded args of one of Relay's deposit events. */
export declare function decodeRelayDeposit(kind: RelayDepositKind, args: Record<string, unknown>, txValue?: bigint): RelayDepositArgs;
/**
 * Resolve a registered fill against its deposit: the output amount (exact, custom, or
 * `inputAmount - fee`), the slippage floor, and the calls with their router.
 */
export declare function planRelayFill(deposit: RelayDepositArgs, fill: RelayFill, defaults?: {
    fee?: RelayFee;
    router?: Address;
}): RelayFillPlan;
/**
 * The parts of a Relay quote response (`POST https://api.relay.link/quote`) that describe the
 * fill. Structural, so a recorded or replayed response can be passed as is.
 */
export interface RelayQuoteLike {
    requestId?: string;
    steps?: readonly {
        requestId?: string;
    }[];
    details?: {
        currencyOut?: {
            currency?: {
                chainId?: number;
            };
        };
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
/** Decode one entry of `orderData.output.calls`. */
export declare function decodeRelayOrderCall(encoded: Hex): RelayCall;
/** Encode a call the way Relay orders carry it (for tests and hand-built quotes). */
export declare function encodeRelayOrderCall(call: RelayCall): Hex;
/**
 * Read a fill out of a Relay quote's `protocol.v2` order: the one payment (recipient, currency,
 * expected and minimum amounts), the calls and the router. Returns the ids to register it under:
 * the order id (what the depository deposit carries) and the request id, if present.
 */
export declare function fillFromQuote(quote: RelayQuoteLike, options?: FillFromQuoteOptions): {
    ids: Hex[];
    fill: RelayFill;
};
//# sourceMappingURL=relay-plan.d.ts.map