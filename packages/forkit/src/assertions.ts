import type { AbiEvent, Address, GetEventArgs, Hex, TransactionReceipt } from "viem";
import { NotImplementedError } from "./errors.ts";

/** Assert that `promise` reverts with a reason string or a 4-byte error selector. */
export async function expectRevert(
  _promise: Promise<unknown>,
  _reasonOrSelector: string | Hex,
): Promise<void> {
  throw new NotImplementedError("expectRevert", 4);
}

/**
 * Assert that `receipt` contains `event`, optionally matching `args`: a partial match on any of
 * the event's params, indexed or not. Values are exact (no event-filter OR arrays or wildcards).
 */
export function expectEmit<const TEvent extends AbiEvent>(
  _receipt: TransactionReceipt,
  _event: TEvent,
  _args?: GetEventArgs<
    readonly [TEvent],
    TEvent["name"],
    { EnableUnion: false; IndexedOnly: false; Required: false }
  >,
): void {
  throw new NotImplementedError("expectEmit", 4);
}

/**
 * Assert that running `fn` changes `holder`'s balance of `token` by exactly `delta`.
 * Resolves to whatever `fn` resolved to.
 */
export async function expectBalanceChange<T>(
  _token: Address,
  _holder: Address,
  _delta: bigint,
  _fn: () => Promise<T>,
): Promise<T> {
  throw new NotImplementedError("expectBalanceChange", 4);
}
