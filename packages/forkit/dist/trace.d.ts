/**
 * Call traces, Foundry-style. anvil's `debug_traceTransaction` / `debug_traceCall` with geth's
 * `callTracer` give the call tree; forkit decodes each frame against known ABIs and labels.
 */
import { type Address, type Hex } from "viem";
import type { RawRequest } from "./client.ts";
/** One frame of geth's `callTracer` output. */
export interface CallFrame {
    type: string;
    from: Address;
    to?: Address;
    value?: Hex;
    gas?: Hex;
    gasUsed?: Hex;
    input: Hex;
    output?: Hex;
    error?: string;
    revertReason?: string;
    calls?: CallFrame[];
    /** With `withLog`: the frame's own events; `position` counts the subcalls before each. */
    logs?: {
        address: Address;
        topics: Hex[];
        data: Hex;
        position?: Hex;
        index?: Hex;
    }[];
}
/** A `debug_trace*` tracer and its config. */
export interface Tracer {
    tracer: string;
    tracerConfig?: Record<string, unknown>;
}
/** The call tree with each frame's events. */
export declare const CALL_TRACER_WITH_LOGS: Tracer;
/** Each touched account's state before and after (only what changed, in `post`). */
export declare const PRESTATE_DIFF: Tracer;
/** A transaction request in JSON-RPC form, as `debug_traceCall` takes it. */
export interface RpcCallRequest {
    from?: Address;
    to?: Address;
    data?: Hex;
    value?: Hex;
    gas?: Hex;
}
export declare function traceTransaction(request: RawRequest, hash: Hex): Promise<CallFrame>;
/** {@link traceTransaction} with another tracer (its result type is the caller's to name). */
export declare function traceTransactionWith<T>(request: RawRequest, hash: Hex, tracer: Tracer): Promise<T>;
export declare function traceCall(request: RawRequest, call: RpcCallRequest, block?: Hex | "latest"): Promise<CallFrame>;
/** {@link traceCall} with another tracer. */
export declare function traceCallWith<T>(request: RawRequest, call: RpcCallRequest, block: Hex | "latest", tracer: Tracer): Promise<T>;
/**
 * Render a call tree the way `forge test -vvvv` does:
 *
 * ```
 * [24091] Vault::audit(5) [staticcall]
 *   ├─ [2412] Ledger::check(5) [staticcall]
 *   │   └─ ← [Revert] Error("Ledger: not enough entries")
 *   └─ ← [Revert] Error("Ledger: not enough entries")
 * ```
 */
export declare function formatTrace(root: CallFrame): string;
//# sourceMappingURL=trace.d.ts.map