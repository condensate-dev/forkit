/**
 * Telling a contract's answer apart from a failed request: a call that reverts, or answers
 * nothing decodable, versus an RPC that is down or a fork that cannot fetch state.
 */

/**
 * viem's errors for a call that ran but answered nothing decodable: no data (an EOA, or a
 * fallback that returns nothing) or data of the wrong shape.
 */
const UNDECODABLE =
  /^(AbiDecoding\w*Error|ContractFunctionZeroDataError|InvalidBytesBooleanError|PositionOutOfBoundsError|SliceOffsetOutOfBoundsError)$/;

/** Every error in `error`'s cause chain, outermost first. */
function causes(error: unknown): object[] {
  const chain: object[] = [];
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !chain.includes(current)) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * What the JSON-RPC errors in the cause chain say: `revert` when the EVM reverted (code 3; geth
 * answers a revert with no data with -32000 "execution reverted"), `failure` for any other code,
 * `undefined` when there is none.
 *
 * viem's `ContractFunctionRevertedError` alone is not enough: viem also reports anvil's internal
 * errors (-32603, e.g. "failed to get storage" when the fork cannot fetch state, or misses the
 * offline cache) as reverts.
 */
function rpcVerdict(error: unknown): "revert" | "failure" | undefined {
  let verdict: "revert" | undefined;
  for (const link of causes(error)) {
    const { code, message, details } = link as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    // -1 is viem's placeholder for an error it could not classify (UnknownRpcError): look deeper.
    if (typeof code !== "number" || code === -1) continue;
    // viem keeps the node's own message in `details`; a raw JSON-RPC error has it in `message`.
    const text = typeof details === "string" ? details : message;
    const reverted =
      code === 3 ||
      (code === -32000 && typeof text === "string" && /^execution reverted$/i.test(text.trim()));
    if (!reverted) return "failure";
    verdict = "revert";
  }
  return verdict;
}

/** Whether `error` is the EVM reverting the call, and not the RPC or the fork failing. */
export function isEvmRevert(error: unknown): boolean {
  return rpcVerdict(error) === "revert";
}

/**
 * Whether `error` means the contract does not implement the function it was called with: the
 * call reverted, or it answered nothing decodable.
 */
export function isMissingFunction(error: unknown): boolean {
  const verdict = rpcVerdict(error);
  if (verdict !== undefined) return verdict === "revert";
  return causes(error).some((link) => {
    const { name } = link as { name?: unknown };
    return typeof name === "string" && UNDECODABLE.test(name);
  });
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
