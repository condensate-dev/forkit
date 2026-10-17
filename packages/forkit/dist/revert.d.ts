/** Find and decode EVM revert data in whatever error viem (or anvil) produced. */
import { type Abi, type Hex } from "viem";
export interface DecodedRevert {
    /**
     * - `reason`: `Error(string)`, from `require(cond, "…")` or `revert("…")`
     * - `panic`: `Panic(uint256)`, from `assert`, overflow, division by zero, ...
     * - `custom`: a custom error (decoded when its ABI is known)
     * - `empty`: reverted with no data (`revert()`, `require(cond)`, out of gas, ...)
     * - `unknown`: it reverted, but the revert data was not available
     */
    kind: "reason" | "panic" | "custom" | "empty" | "unknown";
    /** Raw revert data, when available. */
    data?: Hex;
    /** 4-byte selector of the revert data. */
    selector?: Hex;
    /** The `Error(string)` reason, or viem's description of a panic. */
    reason?: string;
    panicCode?: bigint;
    /** Custom error name and arguments, when the error's ABI is known. */
    errorName?: string;
    args?: readonly unknown[];
}
/** The revert data carried anywhere in an error's `cause` chain. */
export declare function revertDataOf(error: unknown): Hex | undefined;
/**
 * What the JSON-RPC errors in `error`'s cause chain say: `revert` when the EVM reverted (code 3;
 * geth answers a revert with no data with -32000 "execution reverted"), `failure` for any other
 * code, `undefined` when the chain carries no JSON-RPC code.
 *
 * The code is the node's own verdict; viem's error names are not. viem also calls anvil's internal
 * errors (-32603, e.g. "failed to get storage" when the fork cannot fetch state, or misses the
 * offline fork cache) a `ContractFunctionRevertedError`.
 */
export declare function rpcErrorVerdict(error: unknown): "revert" | "failure" | undefined;
/**
 * Whether an error is an EVM revert, as opposed to the RPC or the fork failing: a network error,
 * a rate limit, or anvil's -32603 when the fork cannot fetch state (an offline fork cache miss).
 * Revert data settles it, then the JSON-RPC code (3 is a revert, any other code is not), whatever
 * viem named the error. Only an error that carries neither is judged by its name and message.
 */
export declare function isRevertError(error: unknown): boolean;
/** Decode revert data: `Error(string)`, `Panic(uint256)`, or a custom error from `abi` / known ABIs. */
export declare function decodeRevert(data: Hex | undefined, abi?: Abi): DecodedRevert;
/** `Error("…")`, `Panic(0x12: division or modulo by zero)`, `InsufficientBalance(alice, 1, 2)`. */
export declare function describeRevert(revert: DecodedRevert): string;
/**
 * Decode the revert behind an error. Uses the raw revert data when the error carries it, then
 * viem's own decoding (custom errors it decoded with the call's ABI, or its `reason`).
 */
export declare function revertOf(error: unknown, abi?: Abi): DecodedRevert;
//# sourceMappingURL=revert.d.ts.map