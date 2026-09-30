/**
 * Call traces, Foundry-style. anvil's `debug_traceTransaction` / `debug_traceCall` with geth's
 * `callTracer` give the call tree; forkit decodes each frame against known ABIs and labels.
 */
import {
  type Address,
  decodeFunctionData,
  decodeFunctionResult,
  formatEther,
  type Hex,
  hexToBigInt,
  numberToHex,
  size,
  slice,
} from "viem";
import type { RawRequest } from "./client.ts";
import { formatArgs, formatValue } from "./format.ts";
import { formatAddress, knownFunction, labelOf } from "./labels.ts";
import { decodeRevert, describeRevert } from "./revert.ts";

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
  logs?: { address: Address; topics: Hex[]; data: Hex; position?: Hex; index?: Hex }[];
}

/** A `debug_trace*` tracer and its config. */
export interface Tracer {
  tracer: string;
  tracerConfig?: Record<string, unknown>;
}

/** The call tree with each frame's events. */
export const CALL_TRACER_WITH_LOGS: Tracer = {
  tracer: "callTracer",
  tracerConfig: { withLog: true },
};
/** Each touched account's state before and after (only what changed, in `post`). */
export const PRESTATE_DIFF: Tracer = { tracer: "prestateTracer", tracerConfig: { diffMode: true } };

/** A transaction request in JSON-RPC form, as `debug_traceCall` takes it. */
export interface RpcCallRequest {
  from?: Address;
  to?: Address;
  data?: Hex;
  value?: Hex;
  gas?: Hex;
}

const TRACER: Tracer = { tracer: "callTracer" };

/**
 * Trace a mined transaction. After `evm_revert`, anvil (1.8) cannot find transactions mined
 * since, and `debug_traceTransaction` answers "not found"; only then forkit replays the
 * transaction with `debug_traceCall` on the state of the block before it. That is the
 * transaction's pre-state when each block holds one transaction (automine, forkit's default);
 * with interval mining or several transactions in a block, the replay can differ from what ran.
 */
function isNotFound(error: unknown): boolean {
  for (
    let e: unknown = error;
    typeof e === "object" && e !== null;
    e = (e as { cause?: unknown }).cause
  ) {
    const { code, message, details } = e as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    if (code === -32001) return true;
    if ([message, details].some((m) => typeof m === "string" && /not found/i.test(m))) return true;
  }
  return false;
}

export function traceTransaction(request: RawRequest, hash: Hex): Promise<CallFrame> {
  return traceTransactionWith<CallFrame>(request, hash, TRACER);
}

/** {@link traceTransaction} with another tracer (its result type is the caller's to name). */
export async function traceTransactionWith<T>(
  request: RawRequest,
  hash: Hex,
  tracer: Tracer,
): Promise<T> {
  try {
    return (await request({
      method: "debug_traceTransaction",
      params: [hash, tracer],
    })) as T;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const tx = (await request({ method: "eth_getTransactionByHash", params: [hash] })) as {
      from: Address;
      to: Address | null;
      input: Hex;
      value: Hex;
      gas: Hex;
      blockNumber: Hex | null;
    } | null;
    if (tx === null || tx.blockNumber === null) throw error;
    const parent = hexToBigInt(tx.blockNumber) - 1n;
    return await traceCallWith<T>(
      request,
      {
        from: tx.from,
        ...(tx.to === null ? {} : { to: tx.to }),
        data: tx.input,
        value: tx.value,
        gas: tx.gas,
      },
      numberToHex(parent < 0n ? 0n : parent),
      tracer,
    );
  }
}

export function traceCall(
  request: RawRequest,
  call: RpcCallRequest,
  block: Hex | "latest" = "latest",
): Promise<CallFrame> {
  return traceCallWith<CallFrame>(request, call, block, TRACER);
}

/** {@link traceCall} with another tracer. */
export async function traceCallWith<T>(
  request: RawRequest,
  call: RpcCallRequest,
  block: Hex | "latest",
  tracer: Tracer,
): Promise<T> {
  return (await request({ method: "debug_traceCall", params: [call, block, tracer] })) as T;
}

function describeCall(frame: CallFrame): string {
  // Call targets read like Foundry's: the label alone when there is one.
  const target = frame.to === undefined ? "?" : (labelOf(frame.to) ?? formatAddress(frame.to));
  const value =
    frame.value !== undefined && hexToBigInt(frame.value) > 0n
      ? `{value: ${formatEther(hexToBigInt(frame.value))} ETH}`
      : "";
  const kind = frame.type.toUpperCase();
  const suffix =
    kind === "STATICCALL" ? " [staticcall]" : kind === "DELEGATECALL" ? " [delegatecall]" : "";
  if (kind === "CREATE" || kind === "CREATE2") return `new ${target}${value}`;
  if (frame.input === "0x" || size(frame.input) === 0)
    return `${target}::receive()${value}${suffix}`;
  if (size(frame.input) < 4) return `${target}::fallback(${frame.input})${value}${suffix}`;
  const fn = knownFunction(slice(frame.input, 0, 4));
  if (fn !== undefined) {
    try {
      const { args } = decodeFunctionData({ abi: [fn], data: frame.input });
      return `${target}::${fn.name}${value}(${formatArgs(args)})${suffix}`;
    } catch {
      // Fall through to the raw selector.
    }
  }
  return `${target}::${slice(frame.input, 0, 4)}${value}(${size(frame.input) > 4 ? `${size(frame.input) - 4} bytes` : ""})${suffix}`;
}

function describeResult(frame: CallFrame): string {
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
  if (frame.output === undefined || frame.output === "0x") return "← [Stop]";
  const fn = size(frame.input) >= 4 ? knownFunction(slice(frame.input, 0, 4)) : undefined;
  if (fn !== undefined) {
    try {
      const result = decodeFunctionResult({ abi: [fn], functionName: fn.name, data: frame.output });
      return `← [Return] ${Array.isArray(result) ? formatArgs(result) : formatValue(result)}`;
    } catch {
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
export function formatTrace(root: CallFrame): string {
  const lines: string[] = [];
  const gas = (frame: CallFrame) =>
    frame.gasUsed === undefined ? "" : `[${hexToBigInt(frame.gasUsed)}] `;
  const walk = (frame: CallFrame, indent: string) => {
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
