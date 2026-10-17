/**
 * Simulated cross-chain providers. A bridge simulator watches origin forks for deposit events and,
 * on `settle()`, performs each deposit's fill on its destination fork, the way a relayer or solver
 * would, so cross-chain routes can be tested end to end with no live relayer.
 */
import type { AbiEvent, Address, Hex } from "viem";
import type { Fork } from "../types.ts";
/** A deposit seen on an origin fork. */
export interface Deposit<TArgs = Record<string, unknown>> {
    /** `<originChainId>:<txHash>:<logIndex>`. */
    id: string;
    originChainId: number;
    /** Where it is to be filled (resolved by the bridge). */
    destinationChainId: number;
    txHash: Hex;
    blockNumber: bigint;
    /** Hash of the deposit's block, to tell when an `evm_revert` undid it. */
    blockHash: Hex;
    logIndex: number;
    /** Emitting contract. */
    address: Address;
    /** Decoded event args. */
    args: TArgs;
}
/** What a bridge did for one deposit on the destination. */
export interface Fill<TArgs = Record<string, unknown>> {
    deposit: Deposit<TArgs>;
    destinationChainId: number;
    /** Destination transaction(s) that performed the fill. */
    txHashes: Hex[];
    /** Amount delivered to the recipient, when the bridge knows it. */
    outputAmount?: bigint;
    /** Anything bridge-specific worth asserting on (fees, relayer, message handler, ...). */
    details?: Record<string, unknown>;
}
/** Everything `onDeposit` needs to perform a fill. */
export interface FillContext<TArgs> {
    deposit: Deposit<TArgs>;
    /** The origin chain's handle. */
    origin: Fork;
    /** The destination chain's handle, from the same multi-fork. */
    destination: Fork;
}
/** What `onDeposit` returns: the fill's transactions and, optionally, amounts and details. */
export interface FillResult {
    txHashes?: Hex[];
    outputAmount?: bigint;
    details?: Record<string, unknown>;
}
export interface BridgeSimulator<TArgs = Record<string, unknown>> {
    /** Deposits seen and not filled yet (after the last `poll`/`settle`). */
    readonly pending: readonly Deposit<TArgs>[];
    /** Every fill performed, in order. */
    readonly fills: readonly Fill<TArgs>[];
    /** Scan the origin forks for new deposits; resolves to the new ones. */
    poll(): Promise<Deposit<TArgs>[]>;
    /** Scan, then fill every pending deposit in order; resolves to the fills this call made. */
    settle(): Promise<Fill<TArgs>[]>;
}
export interface CustomBridgeOptions<TEvent extends AbiEvent, TArgs> {
    /** Name in run events and reports (default `custom`). */
    name?: string;
    /** The deposit event, and the contract(s) emitting it per origin chain id. */
    originEvent: {
        event: TEvent;
        address: Readonly<Record<number, Address | readonly Address[]>>;
    };
    /** Destination chain id of a deposit (e.g. from a `destinationChainId` arg). */
    destinationOf: (args: TArgs, originChainId: number) => number | bigint;
    /** Perform the fill on `destination`. */
    onDeposit: (context: FillContext<TArgs>) => Promise<FillResult | undefined>;
}
/**
 * A bridge simulator for any bridge: name the origin deposit event and say how to fill it.
 * `bridge.across` and `bridge.relay` are built on this.
 */
export declare function custom<const TEvent extends AbiEvent, TArgs = Record<string, unknown>>(f: MultiFork, options: CustomBridgeOptions<TEvent, TArgs>): BridgeSimulator<TArgs>;
/** Any fork handle (single or multi-chain); a bridge only needs its per-chain handles. */
export interface MultiFork {
    readonly forks: readonly Fork[];
}
/** The handle for `chainId` in a multi-fork, with an error naming the role when it is missing. */
export declare function handleFor(f: MultiFork, chainId: number, role: "origin" | "destination"): Fork;
//# sourceMappingURL=core.d.ts.map