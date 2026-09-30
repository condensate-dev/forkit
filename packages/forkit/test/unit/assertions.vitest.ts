import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeErrorResult,
  getAddress,
  type Hex,
  parseAbi,
  RpcRequestError,
} from "viem";
import { base } from "viem/chains";
import { beforeEach, describe, expect, test } from "vitest";
import { resolveTraces } from "../../src/fork.ts";
import { abiEqual } from "../../src/format.ts";
import {
  type CallFrame,
  clearLabels,
  decodeRevert,
  describeRevert,
  expectRevert,
  ForkitAssertionError,
  formatAddress,
  formatTrace,
  label,
  registerAbi,
  revertOf,
} from "../../src/index.ts";
import { isRevertError, rpcErrorVerdict } from "../../src/revert.ts";

const alice = "0x00000000000000000000000000000000000a11ce";
const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const abi = parseAbi([
  "error Nope(address who, uint256 amount)",
  "function ping(uint256 n) returns (uint256)",
]);
const reason = (text: string): Hex =>
  `0x08c379a0${encodeAbiParameters([{ type: "string" }], [text]).slice(2)}`;
const nope = encodeErrorResult({ abi, errorName: "Nope", args: [alice, 7n] });

beforeEach(() => clearLabels());

describe("decodeRevert", () => {
  test("Error(string), Panic(uint256), empty and missing data", () => {
    expect(decodeRevert(reason("no"))).toMatchObject({ kind: "reason", reason: "no" });
    const panic: Hex = `0x4e487b71${encodeAbiParameters([{ type: "uint256" }], [0x11n]).slice(2)}`;
    expect(describeRevert(decodeRevert(panic))).toBe(
      "Panic(0x11: arithmetic overflow or underflow)",
    );
    expect(decodeRevert("0x").kind).toBe("empty");
    expect(decodeRevert(undefined).kind).toBe("unknown");
  });

  test("custom errors decode with a given ABI or a registered one, and stay raw otherwise", () => {
    expect(decodeRevert(nope)).toMatchObject({ kind: "custom", selector: nope.slice(0, 10) });
    expect(decodeRevert(nope).errorName).toBeUndefined();
    expect(decodeRevert(nope, abi)).toMatchObject({
      errorName: "Nope",
      args: [getAddress(alice), 7n],
    });
    registerAbi(abi);
    label(alice, "alice");
    expect(describeRevert(decodeRevert(nope))).toBe(`Nope(${formatAddress(alice)}, 7)`);
  });

  test("an argument-less custom error (selector only) decodes by name", () => {
    const bare = parseAbi(["error InvalidNonce()"]);
    const data = encodeErrorResult({ abi: bare, errorName: "InvalidNonce" });
    expect(decodeRevert(data)).toMatchObject({ kind: "custom", selector: data });
    expect(decodeRevert(data, bare)).toMatchObject({ errorName: "InvalidNonce", args: [] });
  });

  test("revertOf digs the data out of a nested cause chain", () => {
    const error = new Error("outer", {
      cause: new Error("mid", { cause: { data: { data: reason("deep") } } }),
    });
    expect(revertOf(error)).toMatchObject({ kind: "reason", reason: "deep" });
  });
});

describe("expectRevert matching (no chain needed)", () => {
  const reverting = (data: Hex) =>
    Promise.reject(Object.assign(new Error("execution reverted"), { data }));

  test("reason, RegExp, selector, signature and ABI forms", async () => {
    await expectRevert(reverting(reason("Vault: zero deposit")), "Vault: zero deposit");
    await expectRevert(reverting(reason("Vault: zero deposit")), /zero/);
    await expectRevert(reverting(nope), nope.slice(0, 10));
    await expectRevert(reverting(nope), "Nope(address, uint256)");
    await expectRevert(reverting(nope), {
      abi,
      errorName: "Nope",
      args: [alice.toUpperCase().replace("0X", "0x"), 7],
    });
  });

  test("a RegExp with g or y flags matches the same way every time", async () => {
    const sticky = /zero/g;
    await expectRevert(reverting(reason("Vault: zero deposit")), sticky);
    await expectRevert(reverting(reason("Vault: zero deposit")), sticky);
    expect(sticky.lastIndex).toBe(0);
  });

  test("a reverted receipt without { client } says how to decode it", async () => {
    const receipt = { status: "reverted", transactionHash: `0x${"11".repeat(32)}` };
    await expect(expectRevert(Promise.resolve(receipt), "x")).rejects.toThrow(
      /Pass \{ client: f.client \}/,
    );
  });

  test("mismatches throw ForkitAssertionError with actual and expected", async () => {
    const failure = await expectRevert(reverting(reason("a")), "b").catch((e) => e);
    expect(failure).toBeInstanceOf(ForkitAssertionError);
    expect(failure).toMatchObject({ actual: 'Error("a")', expected: "b", showDiff: true });
    await expect(
      expectRevert(reverting(nope), { abi, errorName: "Nope", args: [alice, 8n] }),
    ).rejects.toThrow(/expected Nope\(.*, 8\), got Nope\(.*, 7\)/);
  });
});

describe("isRevertError: the JSON-RPC code decides, not viem's error names", () => {
  /** anvil's answer when the fork cannot fetch state; here, an offline fork cache miss. */
  const cacheMiss = {
    code: -32603,
    message: `failed to get storage for ${token}: server returned an error response: error code -32000: forkit: offline and eth_getStorageAt ["${token}","0x9","0x64"] is not in the fork cache (/ci/.forkit-cache/8453/100.json). Run once with FORKIT_CACHE=readwrite and network access to record it.`,
  };
  const reverted = (data: Hex) => ({ code: 3, message: "execution reverted", data });

  /** A client whose node answers every call and estimate with `error`, as anvil would over HTTP. */
  const answering = (error: { code: number; message: string; data?: Hex }) =>
    createPublicClient({
      chain: base,
      transport: custom(
        {
          async request({ method }: { method: string }) {
            if (method === "eth_chainId") return "0x2105";
            throw new RpcRequestError({ body: {}, error, url: "http://127.0.0.1:8545" });
          },
        },
        { retryCount: 0 },
      ),
    });

  /** The same failure, as each viem action a fork test uses reports it. */
  const failures = (error: { code: number; message: string; data?: Hex }) => {
    const client = answering(error);
    const call = { address: token, abi, functionName: "ping", args: [1n] } as const;
    const tx = { account: alice, to: token, data: "0x" } as const;
    return Promise.all(
      [
        client.readContract(call),
        client.simulateContract({ ...call, account: alice }),
        // What forkit's writeContract runs before it sends.
        client.estimateContractGas({ ...call, account: alice }),
        client.estimateGas(tx),
        client.call(tx),
      ].map((p) =>
        p.then(
          () => expect.fail("expected a failure"),
          (e: unknown) => e,
        ),
      ),
    );
  };

  test("an offline fork cache miss (-32603) is not a revert, though viem names it one", async () => {
    const [read, ...rest] = await failures(cacheMiss);
    // viem wraps the read's -32603 in a ContractFunctionRevertedError: that is the trap.
    expect((read as { cause?: { name?: string } }).cause?.name).toBe(
      "ContractFunctionRevertedError",
    );
    for (const failure of [read, ...rest]) {
      expect(rpcErrorVerdict(failure)).toBe("failure");
      expect(isRevertError(failure)).toBe(false);
    }
  });

  test("a code-3 revert still is one, with revert data or with none", async () => {
    for (const data of [reason("Vault: zero deposit"), nope, "0x" as Hex]) {
      for (const failure of await failures(reverted(data))) {
        expect(rpcErrorVerdict(failure)).toBe("revert");
        expect(isRevertError(failure)).toBe(true);
      }
    }
  });

  test("other codes and plain errors are failures; geth's bare -32000 revert is a revert", async () => {
    const rpc = (code: number, message: string) =>
      new RpcRequestError({ body: {}, error: { code, message }, url: "http://x" });
    expect(isRevertError(rpc(-32000, "execution reverted"))).toBe(true);
    expect(isRevertError(rpc(-32000, "header not found"))).toBe(false);
    // anvil 1.8 answers an exceptional halt (out of gas, INVALID) with -32003: not a revert.
    expect(isRevertError(rpc(-32003, "EVM error OutOfGas"))).toBe(false);
    expect(isRevertError(new Error("wrapped", { cause: rpc(3, "execution reverted") }))).toBe(true);
    expect(isRevertError(new Error("fetch failed"))).toBe(false);
    expect(rpcErrorVerdict(new Error("fetch failed"))).toBeUndefined();
    // Revert data settles it; without data or a code, the name and message decide.
    expect(isRevertError({ data: reason("x") })).toBe(true);
    expect(isRevertError(new Error("execution reverted"))).toBe(true);
    expect(
      isRevertError(Object.assign(new Error("x"), { name: "ContractFunctionRevertedError" })),
    ).toBe(true);
  });

  test("expectRevert fails on a cache miss instead of passing it as a revert", async () => {
    const ping = { address: token, abi, functionName: "ping", args: [1n] } as const;
    const failure = await expectRevert(answering(cacheMiss).readContract(ping)).then(
      () => expect.fail("expected expectRevert to fail"),
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(ForkitAssertionError);
    expect((failure as Error).message).toMatch(
      /^forkit: expected a revert, but the call failed another way: [\s\S]*is not in the fork cache/,
    );
    const revert = await expectRevert(
      answering(reverted(reason("Vault: zero deposit"))).readContract(ping),
      "Vault: zero deposit",
    );
    expect(revert).toMatchObject({ kind: "reason", reason: "Vault: zero deposit" });
  });
});

describe("labels", () => {
  test("labelled addresses read as name plus a short checksummed address", () => {
    expect(formatAddress(token)).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    label(token, "USDC");
    expect(formatAddress(token.toUpperCase().replace("0X", "0x"))).toBe("USDC (0x8335…2913)");
  });
});

describe("formatTrace", () => {
  test("renders a nested call tree Foundry-style, decoding known calls", () => {
    registerAbi(abi);
    label(token, "Token");
    const root: CallFrame = {
      type: "CALL",
      from: alice,
      to: token,
      gasUsed: "0x5dc0",
      input: "0x",
      value: "0xde0b6b3a7640000",
      calls: [
        {
          type: "STATICCALL",
          from: token,
          to: alice,
          gasUsed: "0x64",
          input: `0x${"5fbd".padEnd(8, "0")}`,
          output: "0x",
          error: "execution reverted",
        },
      ],
      error: "execution reverted",
      output: nope,
    };
    expect(formatTrace(root)).toBe(
      [
        "[24000] Token::receive(){value: 1 ETH}",
        `  ├─ [100] ${formatAddress(alice)}::0x5fbd0000() [staticcall]`,
        "  │   └─ ← [Revert] execution reverted",
        `  └─ ← [Revert] Nope(${formatAddress(alice)}, 7)`,
      ].join("\n"),
    );
  });
});

describe("abiEqual and the traces option", () => {
  test("bigints, numbers, hex case and nesting", () => {
    expect(abiEqual([1n, { a: "0xAB" }], [1, { a: "0xab" }])).toBe(true);
    expect(abiEqual({ a: 1n }, { a: 1n, b: 2n })).toBe(false);
  });

  test("traces default on, honour FORKIT_TRACES, reject junk", () => {
    expect(resolveTraces(undefined, {})).toBe(true);
    expect(resolveTraces(undefined, { FORKIT_TRACES: "off" })).toBe(false);
    expect(resolveTraces("on-failure", { FORKIT_TRACES: "off" })).toBe(true);
    expect(() => resolveTraces(undefined, { FORKIT_TRACES: "sometimes" })).toThrow(/on-failure/);
  });
});
