import { parseAbiItem, type TransactionReceipt, zeroAddress } from "viem";
import * as forkit from "../src/index.ts";

/** The runtime exports every runner's smoke test checks for. */
export const PUBLIC_FUNCTIONS = [
  "fork",
  "expectRevert",
  "expectEmit",
  "expectBalanceChange",
] as const;

const Transfer = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
// A stub never reads its arguments; the cast only satisfies the signature.
const receipt = { logs: [] } as unknown as TransactionReceipt;

/**
 * One call per API that is still a stub, each expected to reject with NotImplementedError until
 * its milestone (fork is real since milestone 2).
 */
export const STUB_CALLS: Readonly<
  Record<Exclude<(typeof PUBLIC_FUNCTIONS)[number], "fork">, () => Promise<unknown>>
> = {
  expectRevert: () => forkit.expectRevert(Promise.resolve(), "x"),
  // expectEmit throws synchronously; the async wrapper turns that into a rejection.
  expectEmit: async () => forkit.expectEmit(receipt, Transfer),
  expectBalanceChange: () =>
    forkit.expectBalanceChange(zeroAddress, zeroAddress, 0n, async () => 0),
};
