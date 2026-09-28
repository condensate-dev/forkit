/**
 * Foundry-style expectations that work in any runner: they throw {@link ForkitAssertionError}
 * with a readable message (labels, decoded values) and return what they matched.
 */
import {
  type Abi,
  type AbiEvent,
  type Address,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  type GetEventArgs,
  type Hex,
  isAddressEqual,
  keccak256,
  type Log,
  parseEventLogs,
  slice,
  type TransactionReceipt,
  toBytes,
} from "viem";
import { type RawRequest, rawRequest, traceOf } from "./client.ts";
import { ForkitAssertionError } from "./errors.ts";
import { abiEqual, formatArgs, formatValue } from "./format.ts";
import { formatAddress, knownEvent, registerAbi } from "./labels.ts";
import {
  type DecodedRevert,
  decodeRevert,
  describeRevert,
  isRevertError,
  revertOf,
} from "./revert.ts";
import { formatTrace, traceTransaction } from "./trace.ts";

/**
 * What a revert must look like:
 * - a reason string, matched exactly against `Error(string)`: `"Vault: zero deposit"`
 * - a `RegExp`, matched against the reason or the decoded description
 * - a 4-byte selector: `"0x2a3b4c5d"`
 * - an error signature, hashed to its selector: `"InsufficientBalance(address,uint256,uint256)"`
 * - a custom error by ABI: `{ abi, errorName, args? }`, with `args` compared exactly
 */
export type ExpectedRevert =
  | string
  | RegExp
  | { abi: Abi | readonly unknown[]; errorName: string; args?: readonly unknown[] };

export interface ExpectRevertOptions {
  /** Extra ABI to decode custom errors with (known and registered ABIs are always tried). */
  abi?: Abi | readonly unknown[];
  /**
   * A client for the fork, needed only when `promise` resolves to a receipt with status
   * `reverted` (a transaction sent with explicit gas is mined even though it reverts): forkit
   * traces it to recover the revert data.
   */
  client?: { request: unknown };
}

const SELECTOR = /^0x[0-9a-fA-F]{8}$/;
const SIGNATURE = /^[A-Za-z_$][\w$]*\(.*\)$/;

function isReceipt(value: unknown): value is TransactionReceipt {
  return (
    typeof value === "object" && value !== null && "status" in value && "transactionHash" in value
  );
}

function mismatch(revert: DecodedRevert, expected: ExpectedRevert): string | undefined {
  const actual = describeRevert(revert);
  if (typeof expected === "string") {
    if (SELECTOR.test(expected)) {
      return revert.selector?.toLowerCase() === expected.toLowerCase()
        ? undefined
        : `expected a revert with selector ${expected}, got ${actual}`;
    }
    if (SIGNATURE.test(expected)) {
      const selector = slice(keccak256(toBytes(expected.replace(/\s+/g, ""))), 0, 4);
      return revert.selector?.toLowerCase() === selector
        ? undefined
        : `expected ${expected} (selector ${selector}), got ${actual}`;
    }
    return revert.kind === "reason" && revert.reason === expected
      ? undefined
      : `expected Error(${JSON.stringify(expected)}), got ${actual}`;
  }
  if (expected instanceof RegExp) {
    // Without g/y: a stateful lastIndex would make the second .test depend on the first.
    const re = new RegExp(expected.source, expected.flags.replace(/[gy]/g, ""));
    return (revert.reason !== undefined && re.test(revert.reason)) || re.test(actual)
      ? undefined
      : `expected a revert matching ${expected}, got ${actual}`;
  }
  const decoded =
    revert.data === undefined ? revert : decodeRevert(revert.data, expected.abi as Abi);
  const name = decoded.errorName ?? revert.errorName;
  if (name !== expected.errorName) {
    return `expected ${expected.errorName}(…), got ${describeRevert(decoded.errorName ? decoded : revert)}`;
  }
  if (expected.args !== undefined && !abiEqual(decoded.args ?? revert.args ?? [], expected.args)) {
    return `expected ${expected.errorName}(${formatArgs(expected.args)}), got ${name}(${formatArgs(decoded.args ?? revert.args)})`;
  }
  return undefined;
}

async function revertOfReceipt(
  receipt: TransactionReceipt,
  options: ExpectRevertOptions,
): Promise<{ revert: DecodedRevert; trace?: string }> {
  if (options.client === undefined) {
    throw new ForkitAssertionError(
      "forkit: expectRevert got a mined receipt with status reverted, which carries no revert data. Pass { client: f.client } so forkit can trace the transaction and decode why it reverted.",
    );
  }
  const frame = await traceTransaction(rawRequest(options.client), receipt.transactionHash);
  return {
    revert: decodeRevert(frame.output, options.abi as Abi | undefined),
    trace: formatTrace(frame),
  };
}

/**
 * Assert that `promise` reverts, and (optionally) how. Pass the promise of a write, e.g.
 * `expectRevert(f.client.writeContract({...}), "Vault: zero deposit")`. Resolves to the decoded
 * revert for further checks.
 */
export async function expectRevert(
  promise: Promise<unknown>,
  expected?: ExpectedRevert,
  options: ExpectRevertOptions = {},
): Promise<DecodedRevert> {
  if (options.abi !== undefined) registerAbi(options.abi);
  if (typeof expected === "object" && !(expected instanceof RegExp)) registerAbi(expected.abi);
  let revert: DecodedRevert;
  let trace: string | undefined;
  let cause: unknown;
  try {
    const value = await promise;
    if (!isReceipt(value) || value.status !== "reverted") {
      throw new ForkitAssertionError(
        `forkit: expected a revert, but the call succeeded${value === undefined ? "" : ` and returned ${formatValue(value)}`}.`,
      );
    }
    ({ revert, trace } = await revertOfReceipt(value, options));
  } catch (error) {
    if (error instanceof ForkitAssertionError) throw error;
    if (!isRevertError(error)) {
      throw new ForkitAssertionError(
        `forkit: expected a revert, but the call failed another way: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    revert = revertOf(error, options.abi as Abi | undefined);
    trace = traceOf(error);
    cause = error;
  }
  if (expected === undefined) return revert;
  const problem = mismatch(revert, expected);
  if (problem !== undefined) {
    throw new ForkitAssertionError(
      `forkit: ${problem}.${trace === undefined ? "" : `\n\nTrace:\n${trace}`}`,
      {
        actual: describeRevert(revert),
        expected: String(
          expected instanceof RegExp
            ? expected
            : typeof expected === "string"
              ? expected
              : `${expected.errorName}(${formatArgs(expected.args)})`,
        ),
        cause,
      },
    );
  }
  return revert;
}

export interface ExpectEmitOptions {
  /** Only count logs emitted by this contract. */
  address?: Address;
  /** Require exactly this many matching logs (default: at least one). */
  count?: number;
}

/** One line per log in the receipt, decoded with known ABIs where possible. */
function describeLogs(logs: readonly Log[]): string {
  if (logs.length === 0) return "  (no logs)";
  return logs
    .map((log) => {
      const topic0 = log.topics[0];
      const event = topic0 === undefined ? undefined : knownEvent(topic0);
      const where = formatAddress(log.address);
      if (event !== undefined) {
        try {
          const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
          const args = Array.isArray(decoded.args)
            ? formatArgs(decoded.args)
            : Object.entries(decoded.args ?? {})
                .map(([k, v]) => `${k}: ${formatValue(v)}`)
                .join(", ");
          return `  ${where} emitted ${decoded.eventName}(${args})`;
        } catch {
          // Fall through to raw.
        }
      }
      return `  ${where} emitted topic0 ${topic0 ?? "(anonymous)"}`;
    })
    .join("\n");
}

/**
 * Assert that `receipt` contains `event`, optionally with `args` (a partial match: only the
 * given fields are compared; addresses case-insensitively). Returns the matching decoded logs.
 */
export function expectEmit<const TEvent extends AbiEvent>(
  receipt: TransactionReceipt,
  event: TEvent,
  args?: GetEventArgs<
    readonly [TEvent],
    TEvent["name"],
    { EnableUnion: false; IndexedOnly: false; Required: false }
  >,
  options: ExpectEmitOptions = {},
) {
  registerAbi([event]);
  const matching = parseEventLogs({ abi: [event] as const, logs: receipt.logs }).filter(
    (log) =>
      (options.address === undefined || isAddressEqual(log.address, options.address)) &&
      argsMatch((log as { args?: unknown }).args, args),
  );
  const ok = options.count === undefined ? matching.length > 0 : matching.length === options.count;
  if (!ok) {
    const want = `${event.name}${args === undefined ? "" : ` ${formatValue(args)}`}${options.address === undefined ? "" : ` from ${formatAddress(options.address)}`}`;
    const times =
      options.count === undefined
        ? ""
        : ` exactly ${options.count} time(s), got ${matching.length}`;
    throw new ForkitAssertionError(
      `forkit: expected ${want} to be emitted${times} in tx ${receipt.transactionHash}. The receipt has:\n${describeLogs(receipt.logs)}`,
      { actual: matching.length, expected: options.count ?? ">= 1" },
    );
  }
  return matching;
}

/** Partial match: every given field (by name, or by position for unnamed inputs) must equal. */
function argsMatch(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (
    typeof expected !== "object" ||
    expected === null ||
    typeof actual !== "object" ||
    actual === null
  ) {
    return abiEqual(actual, expected);
  }
  return Object.entries(expected).every(
    ([key, value]) =>
      value === undefined || abiEqual((actual as Record<string, unknown>)[key], value),
  );
}

/** Use as `token` in {@link expectBalanceChange} for the native currency. */
export const NATIVE = "native" as const;

async function balanceOf(
  request: RawRequest,
  token: Address | typeof NATIVE,
  holder: Address,
): Promise<bigint> {
  if (token === NATIVE) {
    return BigInt((await request({ method: "eth_getBalance", params: [holder, "latest"] })) as Hex);
  }
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  const result = (await request({
    method: "eth_call",
    params: [{ to: token, data }, "latest"],
  })) as Hex;
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result });
}

/**
 * Assert that running `fn` changes `holder`'s balance of `token` (an ERC-20, or {@link NATIVE})
 * by exactly `delta` (negative for a decrease). Resolves to whatever `fn` resolved to. A native
 * delta includes gas the holder paid.
 */
export async function expectBalanceChange<T>(
  client: { request: unknown },
  token: Address | typeof NATIVE,
  holder: Address,
  delta: bigint,
  fn: () => Promise<T>,
): Promise<T> {
  const request = rawRequest(client);
  const before = await balanceOf(request, token, holder);
  const result = await fn();
  const after = await balanceOf(request, token, holder);
  const actual = after - before;
  if (actual !== delta) {
    const what = token === NATIVE ? "native balance" : `balance of ${formatAddress(token)}`;
    throw new ForkitAssertionError(
      `forkit: expected ${formatAddress(holder)}'s ${what} to change by ${delta}, but it changed by ${actual} (${before} → ${after}).`,
      { actual, expected: delta },
    );
  }
  return result;
}
