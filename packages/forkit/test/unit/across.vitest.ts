import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  type Hex,
  pad,
  parseEventLogs,
  toEventSelector,
  zeroAddress,
} from "viem";
import { describe, expect, test } from "vitest";
import {
  ACROSS_DEFAULT_RELAYER,
  type AcrossDepositArgs,
  across,
  acrossFee,
  acrossLegacyRelayData,
  acrossOrigins,
  acrossOutputAmount,
  acrossRelayData,
  chooseAcrossRelayer,
  decodeAcrossDeposit,
  spokePoolAbi,
} from "../../src/bridges/across.ts";
import { bridge, type MultiFork } from "../../src/bridges/index.ts";
import { ForkitError } from "../../src/index.ts";

const depositor: Address = "0x1111111111111111111111111111111111111111";
const recipient: Address = "0x2222222222222222222222222222222222222222";
const relayer: Address = "0x3333333333333333333333333333333333333333";
const inputToken: Address = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const outputToken: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const b32 = (a: Address) => pad(a, { size: 32 });

/** A raw log of `event` from `spokePool`, as eth_getLogs returns it. */
function rawLog(
  event: "FundsDeposited" | "V3FundsDeposited",
  indexed: Record<string, unknown>,
  data: Hex,
) {
  const abiEvent = getAbiItem({ abi: spokePoolAbi, name: event });
  return {
    address: "0x6f26bf09b1c792e3228e5467807a900a503c0281" as Address,
    topics: encodeEventTopics({ abi: [abiEvent], eventName: event, args: indexed } as never) as [
      Hex,
      ...Hex[],
    ],
    data,
    blockHash: `0x${"ab".repeat(32)}` as Hex,
    blockNumber: 7n,
    logIndex: 3,
    transactionHash: `0x${"cd".repeat(32)}` as Hex,
    transactionIndex: 0,
    removed: false,
  };
}

const expected: AcrossDepositArgs = {
  event: "FundsDeposited",
  depositor,
  recipient,
  inputToken,
  outputToken,
  inputAmount: 1_000_000n,
  outputAmount: 999_000n,
  destinationChainId: 8453n,
  depositId: 42n,
  quoteTimestamp: 1_790_000_000,
  fillDeadline: 1_790_003_600,
  exclusivityDeadline: 1_790_000_600,
  exclusiveRelayer: relayer,
  message: "0xdeadbeef",
};

describe("decoding deposit events", () => {
  test("the event selectors match what the live SpokePools emit", () => {
    // Topics seen in eth_getLogs of the Ethereum, Optimism, Base and Arbitrum SpokePools.
    expect(toEventSelector(getAbiItem({ abi: spokePoolAbi, name: "FundsDeposited" }))).toBe(
      "0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3",
    );
    expect(toEventSelector(getAbiItem({ abi: spokePoolAbi, name: "V3FundsDeposited" }))).toBe(
      "0xa123dc29aebf7d0c3322c8eeb5b999e859f39937950ed31056532713d0de396f",
    );
  });

  test("FundsDeposited: bytes32 fields become checksummed addresses", () => {
    const log = rawLog(
      "FundsDeposited",
      { destinationChainId: 8453n, depositId: 42n, depositor: b32(depositor) },
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint32" },
          { type: "uint32" },
          { type: "uint32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes" },
        ],
        [
          b32(inputToken),
          b32(outputToken),
          1_000_000n,
          999_000n,
          1_790_000_000,
          1_790_003_600,
          1_790_000_600,
          b32(recipient),
          b32(relayer),
          "0xdeadbeef",
        ],
      ),
    );
    const [parsed] = parseEventLogs({ abi: spokePoolAbi, logs: [log] });
    expect(parsed?.eventName).toBe("FundsDeposited");
    const args = decodeAcrossDeposit(
      "FundsDeposited",
      (parsed as unknown as { args: Record<string, unknown> }).args,
    );
    expect(args).toEqual(expected);
  });

  test("V3FundsDeposited: address fields and a uint32 deposit id", () => {
    const log = rawLog(
      "V3FundsDeposited",
      { destinationChainId: 8453n, depositId: 42, depositor },
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint32" },
          { type: "uint32" },
          { type: "uint32" },
          { type: "address" },
          { type: "address" },
          { type: "bytes" },
        ],
        [
          inputToken,
          outputToken,
          1_000_000n,
          999_000n,
          1_790_000_000,
          1_790_003_600,
          1_790_000_600,
          recipient,
          relayer,
          "0xdeadbeef",
        ],
      ),
    );
    const [parsed] = parseEventLogs({ abi: spokePoolAbi, logs: [log] });
    expect(parsed?.eventName).toBe("V3FundsDeposited");
    const args = decodeAcrossDeposit(
      "V3FundsDeposited",
      (parsed as unknown as { args: Record<string, unknown> }).args,
    );
    expect(args).toEqual({ ...expected, event: "V3FundsDeposited" });
  });

  test("a zero exclusive relayer decodes to the zero address", () => {
    const args = decodeAcrossDeposit("FundsDeposited", {
      ...acrossRelayData(expected, 10),
      exclusiveRelayer: pad("0x", { size: 32 }),
      destinationChainId: 8453n,
      quoteTimestamp: 1,
    });
    expect(args.exclusiveRelayer).toBe(zeroAddress);
  });
});

describe("relay data", () => {
  test("fillRelay: bytes32 addresses, the origin chain, the deposit's outputAmount", () => {
    const data = acrossRelayData(expected, 10);
    expect(data).toEqual({
      depositor: b32(depositor),
      recipient: b32(recipient),
      exclusiveRelayer: b32(relayer),
      inputToken: b32(inputToken),
      outputToken: b32(outputToken),
      inputAmount: 1_000_000n,
      outputAmount: 999_000n,
      originChainId: 10n,
      depositId: 42n,
      fillDeadline: 1_790_003_600,
      exclusivityDeadline: 1_790_000_600,
      message: "0xdeadbeef",
    });
    expect(acrossRelayData(expected, 10, 5n).outputAmount).toBe(5n);
    const calldata = encodeFunctionData({
      abi: spokePoolAbi,
      functionName: "fillRelay",
      args: [data, 8453n, b32(relayer)],
    });
    // The selector found in the deployed implementations' bytecode.
    expect(calldata.slice(0, 10)).toBe("0xdeff4b24");
  });

  test("fillV3Relay: addresses and a uint32 deposit id", () => {
    const data = acrossLegacyRelayData(expected, 10, 7n);
    expect(data).toMatchObject({ depositor, recipient, depositId: 42, outputAmount: 7n });
    const calldata = encodeFunctionData({
      abi: spokePoolAbi,
      functionName: "fillV3Relay",
      args: [data, 10n],
    });
    expect(calldata.slice(0, 10)).toBe("0x2e378115");
    expect(() => acrossLegacyRelayData({ ...expected, depositId: 2n ** 32n }, 10)).toThrow(
      /does not fit fillV3Relay's uint32/,
    );
  });
});

describe("choosing the relayer", () => {
  const fallback = ACROSS_DEFAULT_RELAYER;
  test("no exclusive relayer: the default relayer", () => {
    expect(
      chooseAcrossRelayer({ exclusiveRelayer: zeroAddress, exclusivityDeadline: 0 }, 100, fallback),
    ).toEqual({ relayer: fallback, exclusive: false });
    // A deadline without a relayer cannot be exclusive to anyone.
    expect(
      chooseAcrossRelayer(
        { exclusiveRelayer: zeroAddress, exclusivityDeadline: 500 },
        100,
        fallback,
      ),
    ).toEqual({ relayer: fallback, exclusive: false });
  });

  test("an open window, up to and including the deadline: the exclusive relayer", () => {
    const deposit = { exclusiveRelayer: relayer, exclusivityDeadline: 1_000 };
    expect(chooseAcrossRelayer(deposit, 999n, fallback)).toEqual({ relayer, exclusive: true });
    expect(chooseAcrossRelayer(deposit, 1_000, fallback)).toEqual({ relayer, exclusive: true });
  });

  test("a closed window: the default relayer", () => {
    const deposit = { exclusiveRelayer: relayer, exclusivityDeadline: 1_000 };
    expect(chooseAcrossRelayer(deposit, 1_001, fallback)).toEqual({
      relayer: fallback,
      exclusive: false,
    });
  });

  test("the default relayer is a fixed, checksummed address", () => {
    expect(ACROSS_DEFAULT_RELAYER).toBe(getAddress(ACROSS_DEFAULT_RELAYER));
    expect(across.defaultRelayer).toBe(ACROSS_DEFAULT_RELAYER);
  });
});

describe("fees", () => {
  test("outputAmount = inputAmount - (inputAmount * bps / 10_000 + fixed)", () => {
    expect(acrossOutputAmount(1_000_000_000n, { bps: 5, fixed: 20_000n })).toBe(
      1_000_000_000n - 500_000n - 20_000n,
    );
    expect(acrossFee(1_000_000_000n, { bps: 5n })).toBe(500_000n);
    expect(acrossOutputAmount(123n)).toBe(123n);
    expect(across.outputAmount).toBe(acrossOutputAmount);
    expect(across.fee).toBe(acrossFee);
  });

  test("rounds the proportional part down", () => {
    expect(acrossFee(9_999n, { bps: 1 })).toBe(0n);
    expect(acrossFee(10_001n, { bps: 3 })).toBe(3n);
  });

  test("refuses negative fees and fees above the input", () => {
    expect(() => acrossFee(1n, { bps: -1 })).toThrow(ForkitError);
    expect(() => acrossFee(1n, { fixed: -1n })).toThrow(/cannot be negative/);
    expect(() => acrossOutputAmount(10n, { fixed: 11n })).toThrow(/exceeds the input amount/);
  });
});

describe("the SpokePool table and origins", () => {
  test("has Ethereum, Optimism, Base and Arbitrum, checksummed", () => {
    for (const id of [1, 10, 8453, 42161]) {
      const address = across.spokePools[id];
      expect(address).toBeDefined();
      expect(address).toBe(getAddress(address as Address));
    }
    expect(across.spokePools[8453]).toBe("0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64");
    expect(across.spokePools[42161]).toBe("0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A");
  });

  test("defaults to every forked chain with a SpokePool", () => {
    expect(acrossOrigins([10, 8453, 31337])).toEqual([10, 8453]);
    expect(acrossOrigins([31337], { spokePools: { 31337: relayer } })).toEqual([31337]);
  });

  test("an origin with no SpokePool is a clear error", () => {
    expect(() => acrossOrigins([10, 999], { origins: [999] })).toThrow(
      /no SpokePool for origin chain 999/,
    );
    expect(() => acrossOrigins([31337, 31338])).toThrow(
      /knows no SpokePool on any forked chain \(31337, 31338\)/,
    );
  });

  test("bridge.across refuses before touching the fork", () => {
    const local = { forks: [{ chain: { id: 31337, name: "Foundry" } }] } as unknown as MultiFork;
    expect(() => bridge.across(local)).toThrow(/knows no SpokePool on any forked chain/);
    expect(() => bridge.across(local, { origins: [999] })).toThrow(/origin chain 999/);
    expect(() => bridge.across(local, { events: [], spokePools: { 31337: relayer } })).toThrow(
      /at least one deposit event/,
    );
  });

  test("an origin that is not forked is the core's clear error", () => {
    const local = { forks: [{ chain: { id: 31337, name: "Foundry" } }] } as unknown as MultiFork;
    expect(() => bridge.across(local, { origins: [10] })).toThrow(
      /origin chain 10 is not in this fork/,
    );
  });
});
