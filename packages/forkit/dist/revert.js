/** Find and decode EVM revert data in whatever error viem (or anvil) produced. */
import { decodeAbiParameters, decodeErrorResult, size, slice } from "viem";
import { formatArgs } from "./format.js";
import { errorSelector, knownError } from "./labels.js";
const ERROR_STRING = "0x08c379a0";
const PANIC = "0x4e487b71";
/** Solidity panic codes (docs.soliditylang.org, "Panic via assert and error via require"). */
const PANIC_REASONS = {
    0: "generic compiler panic",
    1: "assertion failed",
    17: "arithmetic overflow or underflow",
    18: "division or modulo by zero",
    33: "invalid enum value",
    34: "invalid storage byte array",
    49: "pop on an empty array",
    50: "array index out of bounds",
    65: "out of memory",
    81: "call to an uninitialized function pointer",
};
const isHex = (value) => typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value);
/** The revert data carried anywhere in an error's `cause` chain. */
export function revertDataOf(error) {
    const seen = new Set();
    let current = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
        seen.add(current);
        const { raw, data } = current;
        if (isHex(raw))
            return raw;
        if (isHex(data))
            return data;
        if (typeof data === "object" && data !== null && isHex(data.data)) {
            return data.data;
        }
        current = current.cause;
    }
    return undefined;
}
/** Every error in `error`'s cause chain, outermost first. */
function causes(error) {
    const chain = [];
    let current = error;
    while (typeof current === "object" && current !== null && !chain.includes(current)) {
        chain.push(current);
        current = current.cause;
    }
    return chain;
}
/**
 * What the JSON-RPC errors in `error`'s cause chain say: `revert` when the EVM reverted (code 3;
 * geth answers a revert with no data with -32000 "execution reverted"), `failure` for any other
 * code, `undefined` when the chain carries no JSON-RPC code.
 *
 * The code is the node's own verdict; viem's error names are not. viem also calls anvil's internal
 * errors (-32603, e.g. "failed to get storage" when the fork cannot fetch state, or misses the
 * offline fork cache) a `ContractFunctionRevertedError`.
 */
export function rpcErrorVerdict(error) {
    let verdict;
    for (const link of causes(error)) {
        const { code, message, details } = link;
        // -1 is viem's placeholder for an error it could not classify (UnknownRpcError): look deeper.
        if (typeof code !== "number" || code === -1)
            continue;
        // viem keeps the node's own message in `details`; a raw JSON-RPC error has it in `message`.
        const text = typeof details === "string" ? details : message;
        const reverted = code === 3 ||
            (code === -32000 && typeof text === "string" && /^execution reverted$/i.test(text.trim()));
        if (!reverted)
            return "failure";
        verdict = "revert";
    }
    return verdict;
}
/**
 * Whether an error is an EVM revert, as opposed to the RPC or the fork failing: a network error,
 * a rate limit, or anvil's -32603 when the fork cannot fetch state (an offline fork cache miss).
 * Revert data settles it, then the JSON-RPC code (3 is a revert, any other code is not), whatever
 * viem named the error. Only an error that carries neither is judged by its name and message.
 */
export function isRevertError(error) {
    if (revertDataOf(error) !== undefined)
        return true;
    const verdict = rpcErrorVerdict(error);
    if (verdict !== undefined)
        return verdict === "revert";
    return causes(error).some((link) => {
        const { name, message } = link;
        return (name === "ContractFunctionRevertedError" ||
            name === "ExecutionRevertedError" ||
            (typeof message === "string" && /execution reverted|\breverted\b/i.test(message)));
    });
}
/** Decode revert data: `Error(string)`, `Panic(uint256)`, or a custom error from `abi` / known ABIs. */
export function decodeRevert(data, abi) {
    if (data === undefined)
        return { kind: "unknown" };
    if (data === "0x")
        return { kind: "empty", data };
    if (size(data) < 4)
        return { kind: "custom", data };
    const selector = slice(data, 0, 4).toLowerCase();
    // An argument-less custom error (e.g. `InvalidNonce()`) is just the 4-byte selector, and
    // viem's slice throws on an offset equal to the size.
    const body = size(data) > 4 ? slice(data, 4) : "0x";
    try {
        if (selector === ERROR_STRING) {
            const [reason] = decodeAbiParameters([{ type: "string" }], body);
            return { kind: "reason", data, selector, reason };
        }
        if (selector === PANIC) {
            const [code] = decodeAbiParameters([{ type: "uint256" }], body);
            const text = PANIC_REASONS[Number(code)] ?? "unknown panic";
            return { kind: "panic", data, selector, panicCode: code, reason: text };
        }
    }
    catch {
        return { kind: "custom", data, selector };
    }
    const item = abi?.find((i) => i.type === "error" && errorSelector(i) === selector) ?? knownError(selector);
    if (item !== undefined) {
        try {
            const decoded = decodeErrorResult({ abi: [item], data });
            return {
                kind: "custom",
                data,
                selector,
                errorName: decoded.errorName,
                args: decoded.args ?? [],
            };
        }
        catch {
            // Selector collision or bad data: report it undecoded.
        }
    }
    return { kind: "custom", data, selector };
}
/** `Error("…")`, `Panic(0x12: division or modulo by zero)`, `InsufficientBalance(alice, 1, 2)`. */
export function describeRevert(revert) {
    switch (revert.kind) {
        case "reason":
            return `Error(${JSON.stringify(revert.reason)})`;
        case "panic":
            return `Panic(0x${(revert.panicCode ?? 0n).toString(16).padStart(2, "0")}: ${revert.reason})`;
        case "empty":
            return "revert with no data";
        case "unknown":
            return "revert (no revert data available)";
        case "custom":
            return revert.errorName === undefined
                ? `custom error ${revert.selector ?? revert.data}${revert.data !== undefined && size(revert.data) > 4 ? ` (data ${revert.data})` : ""}`
                : `${revert.errorName}(${formatArgs(revert.args)})`;
    }
}
/**
 * Decode the revert behind an error. Uses the raw revert data when the error carries it, then
 * viem's own decoding (custom errors it decoded with the call's ABI, or its `reason`).
 */
export function revertOf(error, abi) {
    const decoded = decodeRevert(revertDataOf(error), abi);
    if (decoded.kind !== "unknown" &&
        !(decoded.kind === "custom" && decoded.errorName === undefined)) {
        return decoded;
    }
    const seen = new Set();
    let current = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
        seen.add(current);
        const { data, reason } = current;
        if (typeof data === "object" && data !== null && "errorName" in data) {
            const { errorName, args } = data;
            if (errorName !== "Error" && errorName !== "Panic") {
                return { ...decoded, kind: "custom", errorName, args: args ?? [] };
            }
        }
        if (decoded.kind === "unknown" && typeof reason === "string" && reason !== "") {
            return { kind: "reason", reason };
        }
        current = current.cause;
    }
    return decoded;
}
//# sourceMappingURL=revert.js.map