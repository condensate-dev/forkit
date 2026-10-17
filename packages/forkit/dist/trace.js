/**
 * Call traces, Foundry-style. anvil's `debug_traceTransaction` / `debug_traceCall` with geth's
 * `callTracer` give the call tree; forkit decodes each frame against known ABIs and labels.
 */
import { decodeFunctionData, decodeFunctionResult, formatEther, hexToBigInt, numberToHex, size, slice, } from "viem";
import { formatArgs, formatValue } from "./format.js";
import { formatAddress, knownFunction, labelOf } from "./labels.js";
import { decodeRevert, describeRevert } from "./revert.js";
/** The call tree with each frame's events. */
export const CALL_TRACER_WITH_LOGS = {
    tracer: "callTracer",
    tracerConfig: { withLog: true },
};
/** Each touched account's state before and after (only what changed, in `post`). */
export const PRESTATE_DIFF = { tracer: "prestateTracer", tracerConfig: { diffMode: true } };
const TRACER = { tracer: "callTracer" };
/**
 * Trace a mined transaction. After `evm_revert`, anvil (1.8) cannot find transactions mined
 * since, and `debug_traceTransaction` answers "not found"; only then forkit replays the
 * transaction with `debug_traceCall` on the state of the block before it. That is the
 * transaction's pre-state when each block holds one transaction (automine, forkit's default);
 * with interval mining or several transactions in a block, the replay can differ from what ran.
 */
function isNotFound(error) {
    for (let e = error; typeof e === "object" && e !== null; e = e.cause) {
        const { code, message, details } = e;
        if (code === -32001)
            return true;
        if ([message, details].some((m) => typeof m === "string" && /not found/i.test(m)))
            return true;
    }
    return false;
}
export function traceTransaction(request, hash) {
    return traceTransactionWith(request, hash, TRACER);
}
/** {@link traceTransaction} with another tracer (its result type is the caller's to name). */
export async function traceTransactionWith(request, hash, tracer) {
    try {
        return (await request({
            method: "debug_traceTransaction",
            params: [hash, tracer],
        }));
    }
    catch (error) {
        if (!isNotFound(error))
            throw error;
        const tx = (await request({ method: "eth_getTransactionByHash", params: [hash] }));
        if (tx === null || tx.blockNumber === null)
            throw error;
        const parent = hexToBigInt(tx.blockNumber) - 1n;
        return await traceCallWith(request, {
            from: tx.from,
            ...(tx.to === null ? {} : { to: tx.to }),
            data: tx.input,
            value: tx.value,
            gas: tx.gas,
        }, numberToHex(parent < 0n ? 0n : parent), tracer);
    }
}
export function traceCall(request, call, block = "latest") {
    return traceCallWith(request, call, block, TRACER);
}
/** {@link traceCall} with another tracer. */
export async function traceCallWith(request, call, block, tracer) {
    return (await request({ method: "debug_traceCall", params: [call, block, tracer] }));
}
function describeCall(frame) {
    // Call targets read like Foundry's: the label alone when there is one.
    const target = frame.to === undefined ? "?" : (labelOf(frame.to) ?? formatAddress(frame.to));
    const value = frame.value !== undefined && hexToBigInt(frame.value) > 0n
        ? `{value: ${formatEther(hexToBigInt(frame.value))} ETH}`
        : "";
    const kind = frame.type.toUpperCase();
    const suffix = kind === "STATICCALL" ? " [staticcall]" : kind === "DELEGATECALL" ? " [delegatecall]" : "";
    if (kind === "CREATE" || kind === "CREATE2")
        return `new ${target}${value}`;
    if (frame.input === "0x" || size(frame.input) === 0)
        return `${target}::receive()${value}${suffix}`;
    if (size(frame.input) < 4)
        return `${target}::fallback(${frame.input})${value}${suffix}`;
    const fn = knownFunction(slice(frame.input, 0, 4));
    if (fn !== undefined) {
        try {
            const { args } = decodeFunctionData({ abi: [fn], data: frame.input });
            return `${target}::${fn.name}${value}(${formatArgs(args)})${suffix}`;
        }
        catch {
            // Fall through to the raw selector.
        }
    }
    return `${target}::${slice(frame.input, 0, 4)}${value}(${size(frame.input) > 4 ? `${size(frame.input) - 4} bytes` : ""})${suffix}`;
}
function describeResult(frame) {
    if (frame.error !== undefined) {
        const revert = decodeRevert(frame.output);
        if (revert.kind === "unknown" || revert.kind === "empty") {
            return `← [Revert] ${frame.revertReason ?? frame.error}`;
        }
        return `← [Revert] ${describeRevert(revert)}`;
    }
    const kind = frame.type.toUpperCase();
    if (kind === "CREATE" || kind === "CREATE2") {
        return `← [Return] ${frame.output === undefined ? 0 : size(frame.output)} bytes of code`;
    }
    if (frame.output === undefined || frame.output === "0x")
        return "← [Stop]";
    const fn = size(frame.input) >= 4 ? knownFunction(slice(frame.input, 0, 4)) : undefined;
    if (fn !== undefined) {
        try {
            const result = decodeFunctionResult({ abi: [fn], functionName: fn.name, data: frame.output });
            return `← [Return] ${Array.isArray(result) ? formatArgs(result) : formatValue(result)}`;
        }
        catch {
            // Fall through to raw output.
        }
    }
    return `← [Return] ${formatValue(frame.output)}`;
}
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
export function formatTrace(root) {
    const lines = [];
    const gas = (frame) => frame.gasUsed === undefined ? "" : `[${hexToBigInt(frame.gasUsed)}] `;
    const walk = (frame, indent) => {
        const children = frame.calls ?? [];
        for (const child of children) {
            lines.push(`${indent}├─ ${gas(child)}${describeCall(child)}`);
            walk(child, `${indent}│   `);
        }
        lines.push(`${indent}└─ ${describeResult(frame)}`);
    };
    lines.push(`${gas(root)}${describeCall(root)}`);
    walk(root, "  ");
    return lines.join("\n");
}
//# sourceMappingURL=trace.js.map