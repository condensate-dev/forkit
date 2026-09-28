/**
 * Relay simulator, the parts that need no chain: deposit decoding, ids, fill planning and fees,
 * reading a fill out of a Relay quote, and the loud failures (unknown id, chain not in the fork).
 */
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  pad,
  toHex,
} from "viem";
import { describe, expect, test } from "vitest";
import type { MultiFork } from "../../src/bridges/core.ts";
import { relay } from "../../src/bridges/relay.ts";
import {
  RELAY_DEPOSITORY,
  RELAY_NATIVE,
  RELAY_ROUTER,
  relayErc20DepositEvent,
} from "../../src/bridges/relay-contracts.ts";
import {
  decodeRelayDeposit,
  decodeRelayOrderCall,
  encodeRelayOrderCall,
  fillFromQuote,
  planRelayFill,
  type RelayDepositArgs,
  type RelayFill,
  RelayFillError,
  relayKey,
} from "../../src/bridges/relay-plan.ts";
import { ForkitError } from "../../src/index.ts";

const ORDER_ID: Hex = "0x3EE8EB415A6A7579457D1D56E4F7B3C221B63AB16C2CE5F3EF8EECBFC581B815";
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ALICE: Address = "0x00000000000000000000000000000000000A11cE";
const BOB: Address = "0x0000000000000000000000000000000000000B0b";

/**
 * A real `POST https://api.relay.link/quote` response (Base USDC -> Arbitrum USDC, EXACT_OUTPUT,
 * with one destination call: USDC.transfer(0xbeef, 10 USDC)), trimmed to what the simulator reads.
 */
const QUOTE_WITH_CALL = {
  requestId: "0x179060339748044c054f1850f267ee138b64203e1e6ce5d2556ac98b366e5b17",
  details: { currencyOut: { currency: { chainId: 42161 } } },
  protocol: {
    v2: {
      orderId: "0x3ee8eb415a6a7579457d1d56e4f7b3c221b63ab16c2ce5f3ef8eecbfc581b815",
      orderData: {
        output: {
          chainId: "arbitrum",
          payments: [
            {
              recipient: "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
              currency: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
              minimumAmount: "100000000",
              expectedAmount: "100000000",
            },
          ],
          calls: [
            "0x000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e58310000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000000000000000000000000000000000000000beef000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000",
          ],
          deadline: 1791208197,
          extraData: "0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
        },
      },
    },
  },
};

const erc20Deposit = (amount: bigint): RelayDepositArgs => ({
  kind: "erc20",
  id: relayKey(ORDER_ID),
  from: ALICE,
  token: USDC_BASE,
  amount,
});

const toArb = (fill: Partial<RelayFill> = {}): RelayFill => ({
  destinationChainId: 42161,
  recipient: BOB,
  currency: USDC_ARB,
  ...fill,
});

describe("deposit decoding", () => {
  test("RelayErc20Deposit: the order id, depositor, token and amount", () => {
    expect(
      decodeRelayDeposit("erc20", {
        from: ALICE.toLowerCase(),
        token: USDC_BASE.toLowerCase(),
        amount: 5n,
        id: ORDER_ID,
      }),
    ).toEqual({
      kind: "erc20",
      id: ORDER_ID.toLowerCase(),
      from: ALICE,
      token: USDC_BASE,
      amount: 5n,
    });
  });

  test("RelayNativeDeposit: native token", () => {
    expect(decodeRelayDeposit("native", { from: ALICE, amount: 7n, id: ORDER_ID })).toMatchObject({
      kind: "native",
      token: RELAY_NATIVE,
      amount: 7n,
    });
  });

  test("FundsForwardedWithData: the data is the id; the amount is the transaction's value", () => {
    expect(decodeRelayDeposit("receiver", { data: "0xABCD" }, 9n)).toEqual({
      kind: "receiver",
      id: "0xabcd",
      token: RELAY_NATIVE,
      amount: 9n,
    });
    expect(decodeRelayDeposit("receiver", { data: "0xabcd" }).amount).toBeUndefined();
  });

  test("the depository's calldata ends with the order id (as in a real quote's deposit step)", () => {
    const data = encodeFunctionData({
      abi: relay.depositoryAbi,
      functionName: "depositErc20",
      args: ["0x000000000000000000000000000000000000dEaD", USDC_BASE, 100_000_000n, ORDER_ID],
    });
    // The real deposit step of QUOTE_WITH_CALL (amount aside): selector 0xe8017952, id last.
    expect(data.slice(0, 10)).toBe("0xe8017952");
    expect(data.slice(-64).toLowerCase()).toBe(ORDER_ID.slice(2).toLowerCase());
  });

  test("ids are lower-case hex; anything else is refused", () => {
    expect(relayKey("0xAB")).toBe("0xab");
    expect(() => relayKey("0x")).toThrow(RelayFillError);
    expect(() => relayKey("order-1")).toThrow(/not hex data/);
  });
});

describe("fill planning and fees", () => {
  test("default: the whole input, no fee", () => {
    expect(planRelayFill(erc20Deposit(1_000n), toArb())).toEqual({
      recipient: BOB,
      currency: USDC_ARB,
      outputAmount: 1_000n,
      fee: 0n,
      calls: [],
      refundTo: ALICE,
    });
  });

  test("a flat fee from the simulator, overridden per fill", () => {
    expect(planRelayFill(erc20Deposit(1_000n), toArb(), { fee: 30n })).toMatchObject({
      outputAmount: 970n,
      fee: 30n,
    });
    expect(planRelayFill(erc20Deposit(1_000n), toArb({ fee: 5n }), { fee: 30n })).toMatchObject({
      outputAmount: 995n,
      fee: 5n,
    });
  });

  test("basis points plus a fixed part", () => {
    expect(
      planRelayFill(erc20Deposit(1_000_000n), toArb({ fee: { bps: 25, fixed: 100n } })),
    ).toMatchObject({ outputAmount: 1_000_000n - 2_500n - 100n, fee: 2_600n });
  });

  test("an exact amount or a function wins over the fee rule, and reports no fee", () => {
    const exact = planRelayFill(erc20Deposit(1_000n), toArb({ amount: 7n }), { fee: 1n });
    expect(exact.outputAmount).toBe(7n);
    expect(exact.fee).toBeUndefined();
    const slipped = planRelayFill(
      erc20Deposit(1_000n),
      toArb({ amount: ({ inputAmount }) => ((inputAmount ?? 0n) * 99n) / 100n }),
    );
    expect(slipped).toMatchObject({ outputAmount: 990n });
  });

  test("refuses a fee larger than the deposit, and an output below minimumAmount", () => {
    expect(() => planRelayFill(erc20Deposit(10n), toArb({ fee: 11n }))).toThrow(
      /fee 11 is outside the deposited amount 10/,
    );
    expect(() =>
      planRelayFill(erc20Deposit(1_000n), toArb({ fee: 50n, minimumAmount: 960n })),
    ).toThrow(/output 950 is below the order's minimumAmount 960/);
    expect(() => planRelayFill(erc20Deposit(1_000n), toArb({ amount: -1n }))).toThrow(/negative/);
  });

  test("the fee rule needs a known input amount", () => {
    const receiver: RelayDepositArgs = { kind: "receiver", id: "0xab", token: RELAY_NATIVE };
    expect(() => planRelayFill(receiver, toArb())).toThrow(/deposited amount is unknown/);
    expect(planRelayFill(receiver, toArb({ amount: 3n })).outputAmount).toBe(3n);
  });

  test("calls need a router; refunds default to the depositor", () => {
    const calls = [{ to: USDC_ARB, data: "0x1234" as Hex }];
    expect(() => planRelayFill(erc20Deposit(1n), toArb({ calls }))).toThrow(
      /no known Relay router/,
    );
    expect(
      planRelayFill(erc20Deposit(1n), toArb({ calls }), { router: RELAY_ROUTER }),
    ).toMatchObject({ calls, router: expect.stringMatching(/^0xB92F/i), refundTo: ALICE });
  });
});

describe("reading a fill out of a Relay quote", () => {
  test("the order's payment, calls and router, under the order id and the request id", () => {
    const { ids, fill } = fillFromQuote(QUOTE_WITH_CALL);
    expect(ids).toEqual([QUOTE_WITH_CALL.protocol.v2.orderId, QUOTE_WITH_CALL.requestId]);
    expect(fill).toEqual({
      destinationChainId: 42161,
      recipient: getAddress(RELAY_ROUTER),
      currency: USDC_ARB,
      amount: 100_000_000n,
      minimumAmount: 100_000_000n,
      calls: [
        {
          to: USDC_ARB,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: ["0x000000000000000000000000000000000000bEEF", 10_000_000n],
          }),
          value: 0n,
        },
      ],
      router: getAddress(RELAY_ROUTER),
    });
  });

  test("an order call is abi.encode((address to), (bytes data), (uint256 value))", () => {
    const call = { to: BOB, data: "0xdeadbeef" as Hex, value: 42n };
    expect(decodeRelayOrderCall(encodeRelayOrderCall(call))).toEqual(call);
    expect(encodeRelayOrderCall(call)).toBe(
      encodeAbiParameters(
        [
          { type: "tuple", components: [{ name: "to", type: "address" }] },
          { type: "tuple", components: [{ name: "data", type: "bytes" }] },
          { type: "tuple", components: [{ name: "value", type: "uint256" }] },
        ],
        [{ to: BOB }, { data: "0xdeadbeef" }, { value: 42n }],
      ),
    );
  });

  test("minimum picks the slippage floor; the chain slug is the fallback for the chain id", () => {
    const { details: _, ...quote } = structuredClone(QUOTE_WITH_CALL);
    const [payment] = quote.protocol.v2.orderData.output.payments;
    if (payment) payment.minimumAmount = "99000000";
    const { fill } = fillFromQuote(quote, { amount: "minimum" });
    expect(fill).toMatchObject({ destinationChainId: 42161, amount: 99_000_000n });
  });

  test("a quote without a protocol.v2 order is refused", () => {
    expect(() => fillFromQuote({ requestId: "0x01" })).toThrow(/no protocol.v2 order/);
  });
});

/** Just enough of a two-chain fork for the simulator's bookkeeping: `logs` are Base's. */
function stubFork(logs: () => unknown[]): MultiFork {
  let block = 100n;
  // One stable hash per height, agreeing with depositLog's block 101 (pad("0x01")): the bridge
  // core compares block hashes to tell a reverted chain from a grown one.
  const hashOf = (n: bigint) => pad(toHex(n - 100n));
  const member = (id: number, name: string) => ({
    chain: { id, name },
    client: {
      getBlockNumber: async () => block,
      getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => {
        const n = blockNumber ?? block;
        if (n > block) throw new Error(`block ${n} not found`);
        return { number: n, hash: hashOf(n) };
      },
      getLogs: async () => (id === 8453 ? logs() : []),
    },
  });
  const f = { forks: [member(8453, "Base"), member(42161, "Arbitrum One")] };
  return Object.assign(f as unknown as MultiFork, { mine: () => block++ });
}

const depositLog = (id: Hex) => ({
  address: RELAY_DEPOSITORY,
  topics: encodeEventTopics({ abi: [relayErc20DepositEvent], eventName: "RelayErc20Deposit" }),
  data: encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
    [ALICE, USDC_BASE, 1_000n, id],
  ),
  blockNumber: 101n,
  blockHash: pad("0x01"),
  transactionHash: pad("0x02"),
  transactionIndex: 0,
  logIndex: 0,
  removed: false,
});

describe("loud failures", () => {
  test("a deposit whose id has no registered fill fails settle() and poll()", async () => {
    const f = stubFork(() => [depositLog(ORDER_ID)]) as MultiFork & { mine: () => void };
    const b = relay(f);
    await b.poll(); // starts at the head: nothing yet
    f.mine();
    await expect(b.settle()).rejects.toThrow(RelayFillError);
    await expect(b.poll()).rejects.toThrow(
      new RegExp(`erc20 deposit on chain 8453 carries id ${ORDER_ID.toLowerCase()}`),
    );
    // Registering it afterwards picks the deposit up on the next poll.
    b.expect(ORDER_ID, toArb());
    const [found] = await b.poll();
    expect(found?.args).toEqual(erc20Deposit(1_000n));
    expect(b.pending).toHaveLength(1);
  });

  test("a destination chain that is not in the fork is refused at expect()", () => {
    const b = relay(stubFork(() => []));
    expect(() => b.expect(ORDER_ID, toArb({ destinationChainId: 10 }))).toThrow(ForkitError);
    expect(() => b.expect(ORDER_ID, toArb({ destinationChainId: 10 }))).toThrow(
      /destination chain 10 is not in this fork/,
    );
  });

  test("a fork with no known Relay depository is refused", () => {
    const f = { forks: [{ chain: { id: 31337, name: "Anvil" } }] } as unknown as MultiFork;
    expect(() => relay(f)).toThrow(/knows no Relay depository/);
  });

  test("quotes and fills can be registered through the options", () => {
    const b = relay(
      stubFork(() => []),
      {
        quotes: [QUOTE_WITH_CALL],
        fills: { "0x01": toArb() },
      },
    );
    expect(b.expectQuote(QUOTE_WITH_CALL)).toBe(QUOTE_WITH_CALL.protocol.v2.orderId);
    expect(b.solver).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
