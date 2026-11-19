/** Across prefunded orders, the parts that need no chain: the event and function signatures. */
import { toEventSelector, toFunctionSelector } from "viem";
import { getAbiItem } from "viem/utils";
import { describe, expect, test } from "vitest";
import { decodeAcrossPrefunded } from "../../src/bridges/across-prefunded.ts";
import {
  ACROSS_PREFUNDED_ADAPTER_BASE,
  acrossPrefundedAdapterAbi,
  acrossPrefundingStoredEvent,
} from "../../src/bridges/index.ts";

describe("Across's PrefundedAdapter", () => {
  test("PrefundingStored has the topic the adapter on Base emits", () => {
    // topic0 of the adapter's logs on Basescan, and the hash given in forkit's spec.
    expect(toEventSelector(acrossPrefundingStoredEvent)).toBe(
      "0x5d48f46b5dc16d228768bab74bb2e371f21c82004e9fadc08ce039cfe89304c5",
    );
    expect(acrossPrefundingStoredEvent.inputs.map((i) => [i.name, i.type, "indexed" in i])).toEqual(
      [
        ["witness", "bytes32", true],
        ["token", "address", false],
        ["amount", "uint256", false],
      ],
    );
  });

  test("store has the selector in the adapter's verified bytecode", () => {
    expect(toFunctionSelector(getAbiItem({ abi: acrossPrefundedAdapterAbi, name: "store" }))).toBe(
      "0x1e04ce08",
    );
    expect(ACROSS_PREFUNDED_ADAPTER_BASE.toLowerCase()).toBe(
      "0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94",
    );
  });

  test("the event's args are normalised: a lower-case order id, a checksummed token", () => {
    expect(
      decodeAcrossPrefunded({
        witness: "0xABCDEF0000000000000000000000000000000000000000000000000000000001",
        token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        amount: 5n,
      }),
    ).toEqual({
      orderId: "0xabcdef0000000000000000000000000000000000000000000000000000000001",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: 5n,
    });
  });
});
