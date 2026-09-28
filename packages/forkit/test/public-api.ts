import { parseAbiItem, type TransactionReceipt, zeroAddress } from "viem";
import { foundry } from "viem/chains";
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

/** One call per stub, each expected to reject with NotImplementedError until its milestone. */
export const STUB_CALLS: Readonly<
  Record<(typeof PUBLIC_FUNCTIONS)[number], () => Promise<unknown>>
> = {
  fork: () => forkit.fork(foundry),
  expectRevert: () => forkit.expectRevert(Promise.resolve(), "x"),
  // expectEmit throws synchronously; the async wrapper turns that into a rejection.
  expectEmit: async () => forkit.expectEmit(receipt, Transfer),
  expectBalanceChange: () =>
    forkit.expectBalanceChange(zeroAddress, zeroAddress, 0n, async () => 0),
};
