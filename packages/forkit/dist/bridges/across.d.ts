/**
 * `bridge.across(f)`: an Across relayer simulator. It watches each origin fork's SpokePool for
 * deposits and, on `settle()`, fills each one on its destination fork the way an Across relayer
 * does: an impersonated, funded relayer approves the destination SpokePool and calls its fill
 * function with the deposit's relay data. The SpokePool then pays the recipient and runs any
 * message handler for real.
 *
 * Protocol behaviour follows across-protocol/contracts `contracts/spoke-pools/SpokePool.sol`
 * (https://github.com/across-protocol/contracts): `fillRelay` reverts with `NotExclusiveRelayer`
 * while `exclusivityDeadline >= block.timestamp` unless the caller is the exclusive relayer, and
 * with `ExpiredFillDeadline` once `fillDeadline < block.timestamp`; it pulls `outputAmount` of the
 * output token from the caller, sends it to the recipient (unwrapping WETH for EOAs), then calls
 * `handleV3AcrossMessage(token, amount, relayer, message)` on a contract recipient when the
 * message is not empty. See docs/guides/bridges-across.md.
 */
import { type Address, type Hex } from "viem";
import { type BridgeSimulator, type Deposit, type Fill, type MultiFork } from "./core.ts";
export { ACROSS_MULTICALL_HANDLER, ACROSS_SPOKE_POOLS, spokePoolAbi } from "./across-abi.ts";
/** Which SpokePool event a deposit came from. */
export type AcrossDepositEvent = "FundsDeposited" | "V3FundsDeposited";
/**
 * A decoded Across deposit. Both events are normalised to this shape: bytes32 fields become EVM
 * addresses (their low 20 bytes), ids and chain ids are bigints, timestamps are numbers.
 */
export interface AcrossDepositArgs {
    /** `FundsDeposited` on current SpokePools, `V3FundsDeposited` on ones before the bytes32 upgrade. */
    event: AcrossDepositEvent;
    depositor: Address;
    recipient: Address;
    inputToken: Address;
    outputToken: Address;
    inputAmount: bigint;
    outputAmount: bigint;
    destinationChainId: bigint;
    depositId: bigint;
    quoteTimestamp: number;
    fillDeadline: number;
    exclusivityDeadline: number;
    /** `0x000…0` when the deposit has no exclusive relayer. */
    exclusiveRelayer: Address;
    message: Hex;
}
export type AcrossDeposit = Deposit<AcrossDepositArgs>;
export type AcrossFill = Fill<AcrossDepositArgs>;
/** What `bridge.across` reports in each fill's `details`. */
export interface AcrossFillDetails {
    /** `inputAmount - delivered`, in raw token units (meaningful when both tokens share decimals). */
    fee: bigint;
    /** The deposit's own `outputAmount` (the delivered amount differs only with the override). */
    depositOutputAmount: bigint;
    /** Who filled: the exclusive relayer while its window is open, the default relayer otherwise. */
    relayer: Address;
    exclusive: boolean;
    repaymentChainId: number;
    spokePool: Address;
    fillFunction: "fillRelay" | "fillV3Relay";
}
/** A fee as basis points of `inputAmount` plus a fixed amount, both in the input token's units. */
export interface AcrossFeeConfig {
    /** Proportional fee in basis points (1 bps = 0.01 %). Default 0. */
    bps?: number | bigint;
    /** Fixed fee (e.g. gas cost) in raw token units. Default 0. */
    fixed?: bigint;
}
export interface AcrossOptions {
    /**
     * SpokePool addresses by chain id, merged over the built-in table ({@link ACROSS_SPOKE_POOLS}).
     * Use it for a chain the table lacks or a fork of a test deployment.
     */
    spokePools?: Readonly<Record<number, Address>>;
    /**
     * Origin chains to watch. Default: every forked chain with a known SpokePool. Naming a chain
     * with no SpokePool, or one not in the fork, is an error.
     */
    origins?: readonly number[];
    /**
     * The relayer that fills when no exclusive relayer holds the deposit. Default: a fixed test
     * address no one controls on a real chain ({@link ACROSS_DEFAULT_RELAYER}).
     */
    relayer?: Address;
    /**
     * The amount to deliver. Default: the deposit's `outputAmount`, which is what a real relayer
     * must deliver. Override it to model a different fee or slippage, e.g.
     * `(d) => across.outputAmount(d.args.inputAmount, { bps: 4 })`. The fill then carries this
     * amount in its relay data (so its relay hash differs from the deposit's; the destination
     * SpokePool does not check it against the origin).
     */
    outputAmount?: (deposit: AcrossDeposit) => bigint;
    /** Chain the relayer asks to be repaid on. Default: the destination chain. */
    repaymentChainId?: number | ((deposit: AcrossDeposit) => number);
    /**
     * Which deposit events to watch. Default both: `FundsDeposited` (current SpokePools) and
     * `V3FundsDeposited` (SpokePools before the bytes32 upgrade, for forks pinned at old blocks).
     * Deposits of the first event listed settle first.
     */
    events?: readonly AcrossDepositEvent[];
}
/** The default relayer: derived from a hash, so no one holds its key or anything at it. */
export declare const ACROSS_DEFAULT_RELAYER: Address;
/** `outputAmount = inputAmount - fee`, with `fee = inputAmount * bps / 10_000 + fixed`. */
export declare function acrossOutputAmount(inputAmount: bigint, fee?: AcrossFeeConfig): bigint;
/** The fee `acrossOutputAmount` subtracts: `inputAmount * bps / 10_000 + fixed` (rounded down). */
export declare function acrossFee(inputAmount: bigint, fee?: AcrossFeeConfig): bigint;
/** Normalise the decoded args of either deposit event. */
export declare function decodeAcrossDeposit(event: AcrossDepositEvent, args: Record<string, unknown>): AcrossDepositArgs;
/** `V3RelayData` for `fillRelay` (bytes32 addresses). */
export declare function acrossRelayData(args: AcrossDepositArgs, originChainId: number, outputAmount?: bigint): {
    depositor: `0x${string}`;
    recipient: `0x${string}`;
    exclusiveRelayer: `0x${string}`;
    inputToken: `0x${string}`;
    outputToken: `0x${string}`;
    inputAmount: bigint;
    outputAmount: bigint;
    originChainId: bigint;
    depositId: bigint;
    fillDeadline: number;
    exclusivityDeadline: number;
    message: `0x${string}`;
};
/** `V3RelayDataLegacy` for `fillV3Relay` (addresses, uint32 depositId). */
export declare function acrossLegacyRelayData(args: AcrossDepositArgs, originChainId: number, outputAmount?: bigint): {
    depositor: `0x${string}`;
    recipient: `0x${string}`;
    exclusiveRelayer: `0x${string}`;
    inputToken: `0x${string}`;
    outputToken: `0x${string}`;
    inputAmount: bigint;
    outputAmount: bigint;
    originChainId: bigint;
    depositId: number;
    fillDeadline: number;
    exclusivityDeadline: number;
    message: `0x${string}`;
};
/**
 * Who fills: the deposit's exclusive relayer while its window may still be open at `now` (the
 * destination's latest block time; the SpokePool treats `exclusivityDeadline >= block.timestamp`
 * as exclusive, and the exclusive relayer may fill after the window too, so erring towards it is
 * safe), otherwise `fallback`.
 */
export declare function chooseAcrossRelayer(args: Pick<AcrossDepositArgs, "exclusiveRelayer" | "exclusivityDeadline">, now: bigint | number, fallback: Address): {
    relayer: Address;
    exclusive: boolean;
};
/** Origin chain ids to watch, with clear errors for the ones Across cannot serve. */
export declare function acrossOrigins(forkedChainIds: readonly number[], options?: AcrossOptions): number[];
declare function acrossSimulator(f: MultiFork, options?: AcrossOptions): BridgeSimulator<AcrossDepositArgs>;
/**
 * Across relayer simulator on a multi-chain fork, e.g. `fork([arbitrum, base])`.
 *
 * ```ts
 * const b = bridge.across(f);
 * // ... deposit into the origin SpokePool ...
 * const [fill] = await b.settle();
 * fill.outputAmount; // delivered to the recipient on the destination fork
 * fill.details?.fee; // inputAmount - delivered
 * ```
 *
 * Helpers: `across.outputAmount(inputAmount, { bps, fixed })` computes a deposit's
 * `outputAmount`, `across.fee(...)` the fee it subtracts, `across.spokePools` is the address table.
 */
export declare const across: typeof acrossSimulator & {
    outputAmount: typeof acrossOutputAmount;
    fee: typeof acrossFee;
    spokePools: Readonly<Record<number, `0x${string}`>>;
    defaultRelayer: `0x${string}`;
};
//# sourceMappingURL=across.d.ts.map