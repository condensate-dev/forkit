/**
 * Type-level probes, checked by `tsc` (never run). They pin the public signatures that later
 * milestones implement against.
 */
import { type Address, parseAbiItem, type TransactionReceipt } from "viem";
import { expectEmit } from "../src/index.ts";

const Transfer = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
declare const receipt: TransactionReceipt;
declare const alice: Address;

export function expectEmitArgs(): void {
  // Any param, indexed or not, may be asserted; all are optional.
  expectEmit(receipt, Transfer, { from: alice, value: 1n });
  expectEmit(receipt, Transfer, { value: 1n });
  expectEmit(receipt, Transfer);
  // @ts-expect-error event-filter OR arrays are not assertion values
  expectEmit(receipt, Transfer, { from: [alice, alice] });
  // @ts-expect-error a param the event does not have
  expectEmit(receipt, Transfer, { amount: 1n });
  // @ts-expect-error null is an event-filter wildcard, not an assertion value
  expectEmit(receipt, Transfer, { from: null });
  // @ts-expect-error a value of the wrong type
  expectEmit(receipt, Transfer, { value: "1" });
}
