/**
 * `@condensate_dev/forkit/payments` without a network: key derivation, the EIP-712 digests the
 * contracts compute, domain discovery, assertion messages and the token-quirk rules, against a
 * mocked JSON-RPC client. test/e2e/payments-base-ethereum.vitest.ts runs the same code against
 * the real tokens.
 */
import {
  type Address,
  concat,
  createClient,
  custom,
  encodeAbiParameters,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  numberToHex,
  parseAbiParameters,
  RpcRequestError,
  recoverAddress,
  toFunctionSelector,
  toHex,
} from "viem";
import { beforeEach, describe, expect, test } from "vitest";
import { clearLabels, type Fork, ForkitAssertionError, label, labelOf } from "../../src/index.ts";
import * as payments from "../../src/payments/index.ts";
import {
  authorizationNonce,
  blacklist,
  eip2612Abi,
  eip3009Abi,
  expectAllowance,
  expectAuthorizationUnused,
  expectAuthorizationUsed,
  expectPermit2Allowance,
  expectPermit2NonceUnused,
  expectPermit2NonceUsed,
  expectPermitNonce,
  fiatTokenAdminAbi,
  forceApprove,
  PERMIT2,
  permit2Abi,
  permit2Domain,
  permit2Nonce,
  safeTransfer,
  signPermit,
  signPermitSingle,
  signPermitTransferFrom,
  signReceiveWithAuthorization,
  signTransferWithAuthorization,
  testAccount,
  testAddress,
  tokenDomain,
} from "../../src/payments/index.ts";
import { isMissingFunction } from "../../src/payments/read.ts";

const CHAIN_ID = 8453;
const TOKEN: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SPENDER: Address = "0x1111111111111111111111111111111111111111";
const PAYEE: Address = "0x2222222222222222222222222222222222222222";
const owner = testAccount("unit owner");

beforeEach(() => clearLabels());

// ---------------------------------------------------------------------------------------------
// A JSON-RPC client over a table of eth_call answers.

type Answer = Hex | { code: number; message: string; data?: Hex };
type Handler = (data: Hex) => Answer;

const revert = (data: Hex = "0x"): Answer => ({ code: 3, message: "execution reverted", data });
/** What anvil answers when the fork cannot fetch state (e.g. an offline fork cache miss). */
const cacheMiss: Answer = {
  code: -32603,
  message: "failed to get storage: forkit: offline and eth_getStorageAt is not in the fork cache",
};

function selectorOf<const TAbi extends readonly unknown[]>(abi: TAbi, name: string): Hex {
  const item = (abi as readonly { type: string; name?: string }[]).find(
    (i) => i.type === "function" && i.name === name,
  );
  if (item === undefined) throw new Error(`no ${name} in the ABI`);
  return toFunctionSelector(item as never);
}

/**
 * `{ "0xaddress:functionName": handler }`; any other call reverts with no data, like a missing
 * function. Permit2's functions are looked up in its ABI, everything else in the token ABIs.
 */
function mockClient(calls: Record<string, Handler>, code: Record<string, Hex> = {}) {
  const tokenAbis = [erc20Abi, eip2612Abi, eip3009Abi, fiatTokenAdminAbi] as const;
  const bySelector = new Map<string, Handler>();
  for (const [key, handler] of Object.entries(calls)) {
    const [to, name] = key.split(":") as [Address, string];
    const abis = isAddressEqual(to, PERMIT2) ? [permit2Abi] : tokenAbis;
    const abi = abis.find((a) =>
      (a as readonly { type: string; name?: string }[]).some(
        (i) => i.type === "function" && i.name === name,
      ),
    );
    if (abi === undefined) throw new Error(`no ABI has ${name}`);
    bySelector.set(`${to.toLowerCase()}:${selectorOf(abi, name)}`, handler);
  }
  const fail = (error: { code: number; message: string; data?: Hex }) => {
    throw new RpcRequestError({ body: {}, error, url: "http://mock" });
  };
  return createClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const args = (params ?? []) as unknown[];
        if (method === "eth_chainId") return numberToHex(CHAIN_ID);
        if (method === "eth_getCode") return code[String(args[0]).toLowerCase()] ?? "0x";
        if (method === "eth_call") {
          const { to, data } = args[0] as { to: Address; data: Hex };
          const handler = bySelector.get(`${to.toLowerCase()}:${data.slice(0, 10)}`);
          const answer = handler === undefined ? revert() : handler(data);
          return typeof answer === "string" ? answer : fail(answer);
        }
        throw new Error(`mock: unexpected ${method}`);
      },
    }),
  });
}

const returns =
  <const TAbi extends readonly unknown[]>(
    abi: TAbi,
    functionName: string,
    result: unknown,
  ): Handler =>
  () =>
    encodeFunctionResult({
      abi: abi as never,
      functionName: functionName as never,
      result,
    } as never);

/** keccak256(abi.encode(...)) the way Solidity writes it. */
const hashEncoded = (types: string, values: readonly unknown[]): Hex =>
  keccak256(encodeAbiParameters(parseAbiParameters(types), values as never));
const typeHash = (type: string): Hex => keccak256(toHex(type));
/** EIP-712's digest: keccak256("\x19\x01" ‖ domainSeparator ‖ structHash). */
const digestOf = (separator: Hex, structHash: Hex): Hex =>
  keccak256(concat(["0x1901", separator, structHash]));

const USDC_SEPARATOR = hashEncoded("bytes32, bytes32, bytes32, uint256, address", [
  typeHash("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  keccak256(toHex("USD Coin")),
  keccak256(toHex("2")),
  BigInt(CHAIN_ID),
  TOKEN,
]);
const PERMIT2_SEPARATOR = hashEncoded("bytes32, bytes32, uint256, address", [
  typeHash("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
  keccak256(toHex("Permit2")),
  BigInt(CHAIN_ID),
  PERMIT2,
]);

/** A FiatTokenV2_2-shaped token: no eip712Domain(), name "USD Coin", version "2". */
const usdcLike = (overrides: Record<string, Handler> = {}) =>
  mockClient({
    [`${TOKEN}:name`]: returns(eip2612Abi, "name", "USD Coin"),
    [`${TOKEN}:version`]: returns(eip2612Abi, "version", "2"),
    [`${TOKEN}:DOMAIN_SEPARATOR`]: returns(eip2612Abi, "DOMAIN_SEPARATOR", USDC_SEPARATOR),
    [`${TOKEN}:nonces`]: returns(eip2612Abi, "nonces", 5n),
    ...overrides,
  });

const permit2Client = (overrides: Record<string, Handler> = {}) =>
  mockClient(
    {
      [`${PERMIT2}:DOMAIN_SEPARATOR`]: returns(permit2Abi, "DOMAIN_SEPARATOR", PERMIT2_SEPARATOR),
      [`${PERMIT2}:allowance`]: returns(permit2Abi, "allowance", [0n, 0, 7]),
      ...overrides,
    },
    { [PERMIT2.toLowerCase()]: "0x6001" },
  );

// ---------------------------------------------------------------------------------------------

describe("the entry point", () => {
  test("exports exactly the documented runtime API", () => {
    expect(Object.keys(payments).sort()).toEqual(
      [
        "PERMIT2",
        "authorizationNonce",
        "blacklist",
        "eip2612Abi",
        "eip3009Abi",
        "expectAllowance",
        "expectAuthorizationUnused",
        "expectAuthorizationUsed",
        "expectPermit2Allowance",
        "expectPermit2NonceUnused",
        "expectPermit2NonceUsed",
        "expectPermitNonce",
        "fiatTokenAdminAbi",
        "forceApprove",
        "noReturnErc20Abi",
        "pause",
        "permit2Abi",
        "permit2Domain",
        "permit2Nonce",
        "safeTransfer",
        "signPermit",
        "signPermitSingle",
        "signPermitTransferFrom",
        "signReceiveWithAuthorization",
        "signTransferWithAuthorization",
        "testAccount",
        "testAddress",
        "tokenDomain",
      ].sort(),
    );
  });
});

describe("test keys and nonces", () => {
  test("keys and addresses come from fixed strings (the committed recordings depend on them)", () => {
    expect(testAccount("alice").address).toBe(
      getAddress("0xcc31ae4c5a8b943327f6deea46da98e9c616a734"),
    );
    expect(testAddress("bob")).toBe(getAddress("0x3ed66e2d320539415c37b5a926e3af260286b6ed"));
    expect(testAddress("carol")).toBe(getAddress("0xdb18aace5077651560889ebd96581885f3bd034a"));
    expect(testAddress("dave")).toBe(getAddress("0x2711101d30dbf6de6eb82b69065a10b24e727f42"));
    // A keyed account and a keyless address never collide for the same name.
    expect(testAddress("alice")).not.toBe(testAccount("alice").address);
  });

  test("they label the address with the name, unless it already has a label", () => {
    const alice = testAccount("alice");
    expect(labelOf(alice.address)).toBe("alice");
    const bob = testAddress("bob");
    expect(labelOf(bob)).toBe("bob");
    label(bob, "Bob the relayer");
    testAddress("bob");
    expect(labelOf(bob)).toBe("Bob the relayer");
  });

  test("nonces are hashes of the name", () => {
    expect(authorizationNonce("invoice 1")).toBe(
      keccak256(toHex("forkit payments eip3009 invoice 1")),
    );
    expect(permit2Nonce("order 1")).toBe(
      BigInt(keccak256(toHex("forkit payments permit2 order 1"))),
    );
  });
});

describe("signatures recover from the digest the contract computes", () => {
  test("EIP-2612 permit: domain and nonce read from the token", async () => {
    const PERMIT_TYPEHASH = typeHash(
      "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)",
    );
    // EIP-2612's published constant.
    expect(PERMIT_TYPEHASH).toBe(
      "0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9",
    );
    const permit = await signPermit(usdcLike(), {
      token: TOKEN,
      owner,
      spender: SPENDER,
      value: 250n,
      deadline: 1_800_000_000n,
    });
    expect(permit.nonce).toBe(5n);
    expect(permit.domain).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: CHAIN_ID,
      verifyingContract: TOKEN,
    });
    const digest = digestOf(
      USDC_SEPARATOR,
      hashEncoded("bytes32, address, address, uint256, uint256, uint256", [
        PERMIT_TYPEHASH,
        owner.address,
        SPENDER,
        250n,
        5n,
        1_800_000_000n,
      ]),
    );
    expect(await recoverAddress({ hash: digest, signature: permit.signature })).toBe(owner.address);
    expect(permit.args).toEqual([
      owner.address,
      SPENDER,
      250n,
      1_800_000_000n,
      permit.v,
      permit.r,
      permit.s,
    ]);
    expect([27, 28]).toContain(permit.v);
    expect(permit.signature.slice(0, 66)).toBe(permit.r);
  });

  test("an explicit nonce and domain are used as given, with no reads", async () => {
    const domain = { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: TOKEN };
    const permit = await signPermit(mockClient({}), {
      token: TOKEN,
      owner,
      spender: SPENDER,
      value: 1n,
      deadline: 2n,
      nonce: 9n,
      domain,
    });
    expect(permit.nonce).toBe(9n);
    expect(permit.domain).toBe(domain);
  });

  test("EIP-3009 transfer and receive authorizations", async () => {
    const constants = {
      TransferWithAuthorization:
        "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267",
      ReceiveWithAuthorization:
        "0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8",
    } as const;
    const nonce = authorizationNonce("unit invoice");
    for (const [kind, sign] of [
      ["TransferWithAuthorization", signTransferWithAuthorization],
      ["ReceiveWithAuthorization", signReceiveWithAuthorization],
    ] as const) {
      const TYPEHASH = typeHash(
        `${kind}(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)`,
      );
      // EIP-3009's published constants.
      expect(TYPEHASH).toBe(constants[kind]);
      const auth = await sign(usdcLike(), {
        token: TOKEN,
        from: owner,
        to: PAYEE,
        value: 42n,
        validBefore: 1_800_000_000n,
        nonce,
      });
      expect(auth.kind).toBe(kind);
      expect(auth.validAfter).toBe(0n);
      const digest = digestOf(
        USDC_SEPARATOR,
        hashEncoded("bytes32, address, address, uint256, uint256, uint256, bytes32", [
          TYPEHASH,
          owner.address,
          PAYEE,
          42n,
          0n,
          1_800_000_000n,
          nonce,
        ]),
      );
      expect(await recoverAddress({ hash: digest, signature: auth.signature })).toBe(owner.address);
      expect(auth.args).toEqual([
        owner.address,
        PAYEE,
        42n,
        0n,
        1_800_000_000n,
        nonce,
        auth.v,
        auth.r,
        auth.s,
      ]);
    }
  });

  test("Permit2 PermitTransferFrom (SignatureTransfer): signs over the spender", async () => {
    const nonce = permit2Nonce("unit order");
    const signed = await signPermitTransferFrom(permit2Client(), {
      owner,
      token: TOKEN,
      amount: 60n,
      spender: SPENDER,
      nonce,
      deadline: 1_800_000_000n,
    });
    // PermitHash.sol: the spender is msg.sender, hashed in after the token permissions.
    const digest = digestOf(
      PERMIT2_SEPARATOR,
      hashEncoded("bytes32, bytes32, address, uint256, uint256", [
        typeHash(
          "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)",
        ),
        hashEncoded("bytes32, address, uint256", [
          typeHash("TokenPermissions(address token,uint256 amount)"),
          TOKEN,
          60n,
        ]),
        SPENDER,
        nonce,
        1_800_000_000n,
      ]),
    );
    expect(await recoverAddress({ hash: digest, signature: signed.signature })).toBe(owner.address);
    expect(signed.permit).toEqual({
      permitted: { token: TOKEN, amount: 60n },
      nonce,
      deadline: 1_800_000_000n,
    });
    expect(signed.domain).toEqual({
      name: "Permit2",
      chainId: CHAIN_ID,
      verifyingContract: PERMIT2,
    });
  });

  test("Permit2 PermitSingle (AllowanceTransfer): nonce read from allowance()", async () => {
    const signed = await signPermitSingle(permit2Client(), {
      owner,
      token: TOKEN,
      amount: 300n,
      expiration: 1_800_086_400,
      spender: SPENDER,
      sigDeadline: 1_800_000_000n,
    });
    expect(signed.permitSingle.details.nonce).toBe(7);
    const digest = digestOf(
      PERMIT2_SEPARATOR,
      hashEncoded("bytes32, bytes32, address, uint256", [
        typeHash(
          "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)",
        ),
        hashEncoded("bytes32, address, uint160, uint48, uint48", [
          typeHash("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"),
          TOKEN,
          300n,
          1_800_086_400,
          7,
        ]),
        SPENDER,
        1_800_000_000n,
      ]),
    );
    expect(await recoverAddress({ hash: digest, signature: signed.signature })).toBe(owner.address);
    expect(signed.args).toEqual([owner.address, signed.permitSingle, signed.signature]);
  });
});

describe("tokenDomain", () => {
  const eip5267 = (fields: Hex, extensions: bigint[] = [], chainId = BigInt(CHAIN_ID)) =>
    returns(eip2612Abi, "eip712Domain", [
      fields,
      "Token",
      "3",
      chainId,
      TOKEN,
      `0x${"ab".repeat(32)}`,
      extensions,
    ]);

  test("the name()/version() fallback, checked against DOMAIN_SEPARATOR()", async () => {
    expect(await tokenDomain(usdcLike(), TOKEN)).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: CHAIN_ID,
      verifyingContract: TOKEN,
    });
  });

  test("no version() means version 1; no DOMAIN_SEPARATOR() skips the check", async () => {
    const client = mockClient({ [`${TOKEN}:name`]: returns(eip2612Abi, "name", "Plain") });
    expect(await tokenDomain(client, TOKEN)).toEqual({
      name: "Plain",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: TOKEN,
    });
  });

  test("EIP-5267: only the fields the bitmap marks, salt included", async () => {
    expect(
      await tokenDomain(mockClient({ [`${TOKEN}:eip712Domain`]: eip5267("0x0f") }), TOKEN),
    ).toEqual({ name: "Token", version: "3", chainId: CHAIN_ID, verifyingContract: TOKEN });
    expect(
      await tokenDomain(mockClient({ [`${TOKEN}:eip712Domain`]: eip5267("0x0d") }), TOKEN),
    ).toEqual({ name: "Token", chainId: CHAIN_ID, verifyingContract: TOKEN });
    expect(
      await tokenDomain(mockClient({ [`${TOKEN}:eip712Domain`]: eip5267("0x1d") }), TOKEN),
    ).toEqual({
      name: "Token",
      chainId: CHAIN_ID,
      verifyingContract: TOKEN,
      salt: `0x${"ab".repeat(32)}`,
    });
  });

  test("EIP-5267: extensions, or another chain's domain, throw", async () => {
    await expect(
      tokenDomain(mockClient({ [`${TOKEN}:eip712Domain`]: eip5267("0x0f", [7702n]) }), TOKEN),
    ).rejects.toThrow(/uses extensions \(EIP-7702\)/);
    await expect(
      tokenDomain(mockClient({ [`${TOKEN}:eip712Domain`]: eip5267("0x0f", [], 1n) }), TOKEN),
    ).rejects.toThrow(/for chain 1, but this is chain 8453/);
  });

  test("a DOMAIN_SEPARATOR() mismatch throws instead of signing under the wrong domain", async () => {
    const client = usdcLike({
      [`${TOKEN}:version`]: returns(eip2612Abi, "version", "1"),
    });
    await expect(tokenDomain(client, TOKEN)).rejects.toThrow(
      /hashes to 0x[0-9a-f]{64}, but the token's DOMAIN_SEPARATOR\(\) is 0x[0-9a-f]{64}\. Pass the domain explicitly\./,
    );
  });

  test("neither eip712Domain() nor name() throws", async () => {
    await expect(tokenDomain(mockClient({}), TOKEN)).rejects.toThrow(
      /has neither eip712Domain\(\) nor name\(\)/,
    );
  });

  test("a fork cache miss throws; it is not mistaken for a missing function", async () => {
    await expect(
      tokenDomain(usdcLike({ [`${TOKEN}:DOMAIN_SEPARATOR`]: () => cacheMiss }), TOKEN),
    ).rejects.toThrow(/not in the fork cache/);
    await expect(
      tokenDomain(mockClient({ [`${TOKEN}:eip712Domain`]: () => cacheMiss }), TOKEN),
    ).rejects.toThrow(/not in the fork cache/);
  });

  test("an address that answers nothing (no code) has no eip712Domain()", async () => {
    const client = usdcLike({ [`${TOKEN}:eip712Domain`]: () => "0x" });
    expect((await tokenDomain(client, TOKEN)).name).toBe("USD Coin");
  });
});

describe("isMissingFunction", () => {
  // Reverts are core's isRevertError (test/unit/assertions.vitest.ts pins that classification).
  test("EVM reverts and undecodable answers count; RPC failures do not", () => {
    const rpc = (code: number, message: string) =>
      new RpcRequestError({ body: {}, error: { code, message }, url: "http://x" });
    expect(isMissingFunction(new Error("wrapped", { cause: rpc(3, "execution reverted") }))).toBe(
      true,
    );
    expect(isMissingFunction(rpc(-32000, "execution reverted"))).toBe(true);
    expect(isMissingFunction(rpc(-32000, "header not found"))).toBe(false);
    expect(isMissingFunction(rpc(-32603, "failed to get storage"))).toBe(false);
    expect(
      isMissingFunction(Object.assign(new Error("x"), { name: "ContractFunctionZeroDataError" })),
    ).toBe(true);
    expect(isMissingFunction(new Error("fetch failed"))).toBe(false);
    // An undecodable answer behind a failed request is still the request failing.
    expect(
      isMissingFunction(
        Object.assign(new Error("x"), {
          name: "ContractFunctionZeroDataError",
          cause: rpc(-32603, "failed to get storage"),
        }),
      ),
    ).toBe(false);
  });
});

describe("permit2Domain", () => {
  test("checks the domain against DOMAIN_SEPARATOR() and labels Permit2", async () => {
    expect(await permit2Domain(permit2Client())).toEqual({
      name: "Permit2",
      chainId: CHAIN_ID,
      verifyingContract: PERMIT2,
    });
    expect(labelOf(PERMIT2)).toBe("Permit2");
  });

  test("no code, or a different DOMAIN_SEPARATOR(), throws", async () => {
    await expect(permit2Domain(mockClient({}))).rejects.toThrow(
      /Permit2 has no code at Permit2 \(0x0000…8BA3\) on chain 8453/,
    );
    const other = permit2Client({
      [`${PERMIT2}:DOMAIN_SEPARATOR`]: returns(permit2Abi, "DOMAIN_SEPARATOR", USDC_SEPARATOR),
    });
    await expect(permit2Domain(other)).rejects.toThrow(/Is it Permit2\?/);
  });
});

describe("assertions", () => {
  const client = mockClient({
    [`${TOKEN}:allowance`]: returns(erc20Abi, "allowance", 100n),
    [`${TOKEN}:nonces`]: returns(eip2612Abi, "nonces", 1n),
    [`${TOKEN}:authorizationState`]: returns(eip3009Abi, "authorizationState", true),
    // Word 5 has bit 7 set: the nonce (5 << 8) | 7 is used, (5 << 8) | 8 is not.
    [`${PERMIT2}:nonceBitmap`]: returns(permit2Abi, "nonceBitmap", 1n << 7n),
    [`${PERMIT2}:allowance`]: returns(permit2Abi, "allowance", [180n, 1_800_086_400, 1]),
  });
  const holder = testAccount("alice").address;

  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ForkitAssertionError);
    return error as ForkitAssertionError;
  };

  test("expectAllowance and expectPermitNonce resolve to what they read", async () => {
    testAccount("alice"); // labels the holder again after beforeEach cleared the labels
    expect(await expectAllowance(client, TOKEN, holder, SPENDER, 100n)).toBe(100n);
    expect(await expectPermitNonce(client, TOKEN, holder, 1n)).toBe(1n);
    const error = await failure(expectAllowance(client, TOKEN, holder, SPENDER, 5n));
    expect(error.message).toBe(
      `forkit: expected alice (${holder.slice(0, 6)}…${holder.slice(-4)})'s allowance for ${SPENDER} on ${TOKEN} to be 5, but it is 100.`,
    );
    expect([error.actual, error.expected]).toEqual([100n, 5n]);
    await failure(expectPermitNonce(client, TOKEN, holder, 0n));
  });

  test("EIP-3009 authorization state", async () => {
    const nonce = authorizationNonce("x");
    await expectAuthorizationUsed(client, TOKEN, holder, nonce);
    const error = await failure(expectAuthorizationUnused(client, TOKEN, holder, nonce));
    expect(error.message).toMatch(
      /EIP-3009 authorization 0x[0-9a-f]{64} on .* to be unused, but authorizationState is true\.$/,
    );
    expect([error.actual, error.expected]).toEqual([true, false]);
  });

  test("Permit2 nonce bitmap: word nonce >> 8, bit nonce & 0xff", async () => {
    await expectPermit2NonceUsed(client, holder, (5n << 8n) | 7n);
    await expectPermit2NonceUnused(client, holder, (5n << 8n) | 8n);
    const error = await failure(expectPermit2NonceUsed(client, holder, (5n << 8n) | 8n));
    expect(error.message).toMatch(/but bit 8 of nonceBitmap word 5 is 0\.$/);
    // Another Permit2 address is read instead (the mock has no nonceBitmap there).
    await expect(expectPermit2NonceUsed(client, holder, 7n, { permit2: TOKEN })).rejects.toThrow(
      /"nonceBitmap" reverted/,
    );
  });

  test("expectPermit2Allowance compares only the fields given", async () => {
    expect(await expectPermit2Allowance(client, TOKEN, holder, SPENDER, { amount: 180n })).toEqual({
      amount: 180n,
      expiration: 1_800_086_400,
      nonce: 1,
    });
    const error = await failure(
      expectPermit2Allowance(client, TOKEN, holder, SPENDER, { amount: 180n, nonce: 2 }),
    );
    expect(error.message).toMatch(/to have amount 180, nonce 2, but it has amount 180, nonce 1\.$/);
    expect(error.actual).toEqual({ amount: 180n, nonce: 1 });
    expect(error.expected).toEqual({ amount: 180n, nonce: 2 });
  });
});

describe("token quirks (the SafeERC20 rule), on a fake fork", () => {
  const TRUE = encodeAbiParameters([{ type: "bool" }], [true]);
  const FALSE = encodeAbiParameters([{ type: "bool" }], [false]);
  const APPROVE = toFunctionSelector("approve(address,uint256)");

  /** A fork whose pranked client answers eth_call with `answer` and records what it sends. */
  function fakeFork(answer: (data: Hex) => Hex | "revert" | "miss", code: Hex = "0x6001") {
    const sent: Hex[] = [];
    const client = {
      async call({ data }: { data: Hex }) {
        const out = answer(data);
        if (out === "revert" || out === "miss")
          throw new RpcRequestError({
            body: {},
            error: out === "revert" ? revert() : cacheMiss,
            url: "x",
          } as never);
        return { data: out };
      },
      async getCode() {
        return code;
      },
      async sendTransaction({ data }: { data: Hex }) {
        sent.push(data);
        return keccak256(data);
      },
    };
    const f = { prank: (_: Address, fn: (c: typeof client) => unknown) => fn(client) };
    return { f: f as unknown as Fork, sent };
  }
  const approveArg = (data: Hex) => BigInt(`0x${data.slice(-64)}`);

  test("forceApprove approves directly when the token allows it", async () => {
    const { f, sent } = fakeFork(() => TRUE);
    const result = await forceApprove(f, {
      token: TOKEN,
      owner: owner.address,
      spender: SPENDER,
      amount: 5n,
    });
    expect(result.reset).toBe(false);
    expect(sent.map(approveArg)).toEqual([5n]);
    expect(result.hash).toBe(keccak256(sent[0] as Hex));
  });

  test("forceApprove resets to 0 first when the direct approve reverts (USDT)", async () => {
    // USDT: approve(nonzero) reverts while the allowance is nonzero, and returns nothing.
    let allowance = 3n;
    const { f, sent } = fakeFork((data) => {
      const value = approveArg(data);
      if (data.startsWith(APPROVE) && value !== 0n && allowance !== 0n) return "revert";
      allowance = value;
      return "0x";
    });
    const result = await forceApprove(f, {
      token: TOKEN,
      owner: owner.address,
      spender: SPENDER,
      amount: 5n,
    });
    expect(result.reset).toBe(true);
    expect(sent.map(approveArg)).toEqual([0n, 5n]);
  });

  test("forceApprove does not take a failed request for a refusal", async () => {
    const { f, sent } = fakeFork(() => "miss");
    await expect(
      forceApprove(f, { token: TOKEN, owner: owner.address, spender: SPENDER, amount: 5n }),
    ).rejects.toThrow(/not in the fork cache/);
    expect(sent).toEqual([]);
  });

  test("safeTransfer accepts no return data, and refuses false or a token with no code", async () => {
    const params = { token: TOKEN, from: owner.address, to: PAYEE, amount: 1n };
    expect(await safeTransfer(fakeFork(() => "0x").f, params)).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(safeTransfer(fakeFork(() => FALSE).f, params)).rejects.toThrow(
      /safeTransfer: .* returned 0x0{64}, which is neither nothing nor true\./,
    );
    await expect(safeTransfer(fakeFork(() => "0x", "0x").f, params)).rejects.toThrow(
      /safeTransfer: .* has no code\./,
    );
    await expect(safeTransfer(fakeFork(() => "0x01").f, params)).rejects.toThrow(
      /neither nothing nor true/,
    );
  });

  test("blacklist and pause name the token when it is not a FiatToken", async () => {
    const f = {
      client: mockClient({}),
      prank: () => {
        throw new Error("must not prank");
      },
    } as unknown as Fork;
    await expect(blacklist(f, TOKEN, PAYEE)).rejects.toThrow(
      /blacklist: .* has no blacklister\(\)\. blacklist works with Circle's FiatToken \(USDC, EURC\)\./,
    );
    await expect(payments.pause(f, TOKEN)).rejects.toThrow(/pause: .* has no pauser\(\)/);
  });
});
