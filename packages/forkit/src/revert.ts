/** Find and decode EVM revert data in whatever error viem (or anvil) produced. */
import { type Abi, decodeAbiParameters, decodeErrorResult, type Hex, size, slice } from "viem";
import { formatArgs } from "./format.ts";
import { errorSelector, knownError } from "./labels.ts";

const ERROR_STRING = "0x08c379a0";
const PANIC = "0x4e487b71";

/** Solidity panic codes (docs.soliditylang.org, "Panic via assert and error via require"). */
const PANIC_REASONS: Readonly<Record<number, string>> = {
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

const isHex = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value);

/** The revert data carried anywhere in an error's `cause` chain. */
export function revertDataOf(error: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { raw, data } = current as { raw?: unknown; data?: unknown };
    if (isHex(raw)) return raw;
    if (isHex(data)) return data;
    if (typeof data === "object" && data !== null && isHex((data as { data?: unknown }).data)) {
      return (data as { data: Hex }).data;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Whether an error is an EVM revert, as opposed to e.g. a network or signing failure. */
export function isRevertError(error: unknown): boolean {
  if (revertDataOf(error) !== undefined) return true;
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { name, message, code } = current as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
    };
    if (name === "ContractFunctionRevertedError" || name === "ExecutionRevertedError") return true;
    if (code === 3) return true;
    if (typeof message === "string" && /execution reverted|\breverted\b/i.test(message))
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Decode revert data: `Error(string)`, `Panic(uint256)`, or a custom error from `abi` / known ABIs. */
export function decodeRevert(data: Hex | undefined, abi?: Abi): DecodedRevert {
  if (data === undefined) return { kind: "unknown" };
  if (data === "0x") return { kind: "empty", data };
  if (size(data) < 4) return { kind: "custom", data };
  const selector = slice(data, 0, 4).toLowerCase() as Hex;
  // An argument-less custom error (e.g. `InvalidNonce()`) is just the 4-byte selector, and
  // viem's slice throws on an offset equal to the size.
  const body: Hex = size(data) > 4 ? slice(data, 4) : "0x";
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
  } catch {
    return { kind: "custom", data, selector };
  }
  const item =
    abi?.find(
      (i): i is Extract<Abi[number], { type: "error" }> =>
        i.type === "error" && errorSelector(i) === selector,
    ) ?? knownError(selector);
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
    } catch {
      // Selector collision or bad data: report it undecoded.
    }
  }
  return { kind: "custom", data, selector };
}

/** `Error("…")`, `Panic(0x12: division or modulo by zero)`, `InsufficientBalance(alice, 1, 2)`. */
export function describeRevert(revert: DecodedRevert): string {
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
export function revertOf(error: unknown, abi?: Abi): DecodedRevert {
  const decoded = decodeRevert(revertDataOf(error), abi);
  if (
    decoded.kind !== "unknown" &&
    !(decoded.kind === "custom" && decoded.errorName === undefined)
  ) {
    return decoded;
  }
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { data, reason } = current as { data?: unknown; reason?: unknown };
    if (typeof data === "object" && data !== null && "errorName" in data) {
      const { errorName, args } = data as { errorName: string; args?: readonly unknown[] };
      if (errorName !== "Error" && errorName !== "Panic") {
        return { ...decoded, kind: "custom", errorName, args: args ?? [] };
      }
    }
    if (decoded.kind === "unknown" && typeof reason === "string" && reason !== "") {
      return { kind: "reason", reason };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return decoded;
}
