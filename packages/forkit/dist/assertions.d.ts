/**
 * Foundry-style expectations that work in any runner: they throw {@link ForkitAssertionError}
 * with a readable message (labels, decoded values) and return what they matched.
 */
import { type Abi, type AbiEvent, type Address, type GetEventArgs, type Log, type TransactionReceipt } from "viem";
import { type DecodedRevert } from "./revert.ts";
/**
 * What a revert must look like:
 * - a reason string, matched exactly against `Error(string)`: `"Vault: zero deposit"`
 * - a `RegExp`, matched against the reason or the decoded description
 * - a 4-byte selector: `"0x2a3b4c5d"`
 * - an error signature, hashed to its selector: `"InsufficientBalance(address,uint256,uint256)"`
 * - a custom error by ABI: `{ abi, errorName, args? }`, with `args` compared exactly
 */
export type ExpectedRevert = string | RegExp | {
    abi: Abi | readonly unknown[];
    errorName: string;
    args?: readonly unknown[];
};
export interface ExpectRevertOptions {
    /** Extra ABI to decode custom errors with (known and registered ABIs are always tried). */
    abi?: Abi | readonly unknown[];
    /**
     * A client for the fork, needed only when `promise` resolves to a receipt with status
     * `reverted` (a transaction sent with explicit gas is mined even though it reverts): forkit
     * traces it to recover the revert data.
     */
    client?: {
        request: unknown;
    };
}
/**
 * Assert that `promise` reverts, and (optionally) how. Pass the promise of a write, e.g.
 * `expectRevert(f.client.writeContract({...}), "Vault: zero deposit")`. Resolves to the decoded
 * revert for further checks.
 */
export declare function expectRevert(promise: Promise<unknown>, expected?: ExpectedRevert, options?: ExpectRevertOptions): Promise<DecodedRevert>;
export interface ExpectEmitOptions {
    /** Only count logs emitted by this contract. */
    address?: Address;
    /** Require exactly this many matching logs (default: at least one). */
    count?: number;
}
/**
 * Assert that `receipt` contains `event`, optionally with `args` (a partial match: only the
 * given fields are compared; addresses case-insensitively). Returns the matching decoded logs.
 */
export declare function expectEmit<const TEvent extends AbiEvent>(receipt: TransactionReceipt, event: TEvent, args?: GetEventArgs<readonly [TEvent], TEvent["name"], {
    EnableUnion: false;
    IndexedOnly: false;
    Required: false;
}>, options?: ExpectEmitOptions): Log<bigint, number, false, undefined, true, readonly [TEvent], undefined>[];
/** Use as `token` in {@link expectBalanceChange} for the native currency. */
export declare const NATIVE: "native";
/**
 * Assert that running `fn` changes `holder`'s balance of `token` (an ERC-20, or {@link NATIVE})
 * by exactly `delta` (negative for a decrease). Resolves to whatever `fn` resolved to. A native
 * delta includes gas the holder paid.
 */
export declare function expectBalanceChange<T>(client: {
    request: unknown;
}, token: Address | typeof NATIVE, holder: Address, delta: bigint, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=assertions.d.ts.map