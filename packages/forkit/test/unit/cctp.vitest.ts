/** Circle CCTP, the parts that need no chain: the event topics, decoding and the default fee. */
import { toEventSelector } from "viem";
import { describe, expect, test } from "vitest";
import {
  type CctpV2DepositArgs,
  cctpDefaultFee,
  cctpDepositForBurnV1Event,
  cctpDepositForBurnV2Event,
  decodeCctpDeposit,
} from "../../src/bridges/index.ts";

describe("CCTP DepositForBurn", () => {
  test("each version has the topic Circle's TokenMessengers emit on Base", () => {
    // topic0 of live Base logs: the v1 TokenMessenger and TokenMessengerV2.
    expect(toEventSelector(cctpDepositForBurnV1Event)).toBe(
      "0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0",
    );
    expect(toEventSelector(cctpDepositForBurnV2Event)).toBe(
      "0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5",
    );
  });

  const common = {
    burnToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    amount: 5n,
    depositor: "0x0000000000000000000000000000000000000a11",
    mintRecipient: `0x${"00".repeat(12)}${"bb".repeat(20)}`,
    destinationDomain: 2,
    destinationTokenMessenger: `0x${"00".repeat(32)}`,
    destinationCaller: `0x${"00".repeat(32)}`,
  };

  test("decodes v1 with its nonce and v2 with its fee fields, addresses checksummed", () => {
    expect(decodeCctpDeposit(1, { ...common, nonce: 9n })).toMatchObject({
      version: 1,
      nonce: 9n,
      burnToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });
    expect(
      decodeCctpDeposit(2, { ...common, maxFee: 3n, minFinalityThreshold: 1000, hookData: "0x" }),
    ).toMatchObject({ version: 2, maxFee: 3n, minFinalityThreshold: 1000, hookData: "0x" });
  });

  test("a missing field fails loudly", () => {
    expect(() => decodeCctpDeposit(1, common)).toThrow(/field nonce is undefined/);
  });

  test("the default fee: maxFee for a Fast Transfer, 0 for a Standard Transfer", () => {
    const args = (minFinalityThreshold: number): CctpV2DepositArgs => ({
      ...decodeCctpDeposit(2, { ...common, maxFee: 3n, minFinalityThreshold, hookData: "0x" }),
      version: 2,
      maxFee: 3n,
      minFinalityThreshold,
      hookData: "0x",
    });
    expect(cctpDefaultFee(args(1000))).toBe(3n);
    expect(cctpDefaultFee(args(2000))).toBe(0n);
  });
});
