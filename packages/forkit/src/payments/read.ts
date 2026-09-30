/**
 * Telling a contract's answer apart from a failed request: a call that reverts, or answers
 * nothing decodable, versus an RPC that is down or a fork that cannot fetch state. The revert
 * side is core's {@link isRevertError}, which trusts the JSON-RPC code over viem's error names.
 */
import { isRevertError, rpcErrorVerdict } from "../revert.ts";

/**
 * viem's errors for a call that ran but answered nothing decodable: no data (an EOA, or a
 * fallback that returns nothing) or data of the wrong shape.
 */
const UNDECODABLE =
  /^(AbiDecoding\w*Error|ContractFunctionZeroDataError|InvalidBytesBooleanError|PositionOutOfBoundsError|SliceOffsetOutOfBoundsError)$/;

/** Whether an error in `error`'s cause chain is one of viem's {@link UNDECODABLE} errors. */
function isUndecodable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { name } = current as { name?: unknown };
    if (typeof name === "string" && UNDECODABLE.test(name)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Whether `error` means the contract does not implement the function it was called with: the
 * call reverted, or it answered nothing decodable. A request the node failed (a JSON-RPC error
 * other than a revert, such as an offline fork cache miss) is neither.
 */
export function isMissingFunction(error: unknown): boolean {
  if (isRevertError(error)) return true;
  if (rpcErrorVerdict(error) !== undefined) return false;
  return isUndecodable(error);
}

/**
 * `read()`, or `undefined` when the contract does not implement the function. Anything else (the
 * RPC is down, the fork cache missed offline) still throws: a silent `undefined` there would pick
 * the wrong EIP-712 domain, or skip the check that catches one.
 */
export async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (isMissingFunction(error)) return undefined;
    throw error;
  }
}
