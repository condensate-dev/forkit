import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, getAddress, type Hex, pad, parseEther, zeroAddress } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  bridge,
  CctpError,
  type CctpOptions,
  type FillJournalEntry,
} from "../../src/bridges/index.ts";
import { type Fork, fork, type SnapshotId } from "../../src/index.ts";
import { CCTP_MESSENGER_STUB_RUNTIME, cctpMessengerStubAbi } from "../fixtures/cctp.ts";
import { COIN_BYTECODE, coinAbi } from "../fixtures/coin.ts";
import { alice, startUpstreams } from "./adapter-contract.ts";
import { otherChain } from "./upstream.ts";

// bridge.cctp on two local anvils. The same stub sits at one address on both: on the origin it
// emits Circle's DepositForBurn events, on the destination it maps the burned token to a plain
// ERC-20, as Circle's TokenMinter does.

const messenger: Address = "0x000000000000000000000000000000000000cc79";
const bob = getAddress("0x0000000000000000000000000000000000000b0b");
const burnToken = getAddress("0x0000000000000000000000000000000000001234");
const ORIGIN_DOMAIN = 100;
const DESTINATION_DOMAIN = 101;
const BASE_DOMAIN = 6; // in CCTP_DOMAINS, and Base is not in this fork

let upstreams: Awaited<ReturnType<typeof startUpstreams>>;
let f: Fork<typeof foundry>;
let coin: Address;
let snapshots: [Fork, SnapshotId][] = [];

beforeAll(async () => {
  upstreams = await startUpstreams();
  f = await fork([
    { chain: foundry, forkUrl: upstreams.a.url, blockNumber: 0n, cache: "off" },
    { chain: otherChain, forkUrl: upstreams.b.url, blockNumber: 0n, cache: "off" },
  ]);
  const other = f.on(otherChain);
  await f.dealNative(alice, parseEther("100"));
  await other.dealNative(alice, parseEther("100"));
  await f.client.setCode({ address: messenger, bytecode: CCTP_MESSENGER_STUB_RUNTIME });
  await other.client.setCode({ address: messenger, bytecode: CCTP_MESSENGER_STUB_RUNTIME });
  const [deployer] = await other.client.getAddresses();
  const hash = await other.client.deployContract({
    abi: coinAbi,
    bytecode: COIN_BYTECODE,
    args: [0n],
    account: deployer as Address,
  });
  coin = getAddress(
    (await other.client.waitForTransactionReceipt({ hash })).contractAddress as Address,
  );
  await other.prank(alice, (c) =>
    c.writeContract({
      address: messenger,
      abi: cctpMessengerStubAbi,
      functionName: "setLocalToken",
      args: [coin],
    }),
  );
});

beforeEach(async () => {
  await Promise.all(snapshots.map(([g, id]) => g.revertTo(id)));
  snapshots = await Promise.all(
    f.forks.map(async (g): Promise<[Fork, SnapshotId]> => [g, await g.snapshot()]),
  );
});

afterAll(async () => {
  await f?.stop();
  await upstreams?.stop();
});

const simulator = (options: CctpOptions = {}) =>
  bridge.cctp(f, {
    tokenMessengers: { [foundry.id]: messenger },
    domains: { [foundry.id]: ORIGIN_DOMAIN, [otherChain.id]: DESTINATION_DOMAIN },
    ...options,
  });

const burnV1 = (
  nonce: bigint,
  amount: bigint,
  recipient: Hex = pad(bob),
  domain = DESTINATION_DOMAIN,
) =>
  f.prank(alice, (c) =>
    c.writeContract({
      address: messenger,
      abi: cctpMessengerStubAbi,
      functionName: "burnV1",
      args: [nonce, burnToken, amount, recipient, domain, pad(messenger)],
    }),
  );

const burnV2 = (amount: bigint, maxFee: bigint, threshold: number, hookData: Hex = "0x") =>
  f.prank(alice, (c) =>
    c.writeContract({
      address: messenger,
      abi: cctpMessengerStubAbi,
      functionName: "burnV2",
      args: [
        burnToken,
        amount,
        pad(bob),
        DESTINATION_DOMAIN,
        pad(messenger),
        maxFee,
        threshold,
        hookData,
      ],
    }),
  );

const coinOf = (holder: Address) =>
  f.on(otherChain).client.readContract({
    address: coin,
    abi: coinAbi,
    functionName: "balanceOf",
    args: [holder],
  });

test("a v1 burn: the mint recipient is credited with the amount, by deal", async () => {
  const cctp = simulator();
  await burnV1(7n, 1_000_000n);
  const [fill, ...rest] = await cctp.settle();
  expect(rest).toEqual([]);
  expect(await coinOf(bob)).toBe(1_000_000n);
  expect(fill?.txHashes).toEqual([]);
  expect(fill?.outputAmount).toBe(1_000_000n);
  expect(fill?.destinationChainId).toBe(otherChain.id);
  expect(fill?.deposit.args).toMatchObject({
    version: 1,
    nonce: 7n,
    burnToken,
    amount: 1_000_000n,
  });
  expect(fill?.details).toMatchObject({
    version: 1,
    token: coin,
    recipient: bob,
    fee: 0n,
    credit: "deal",
  });
});

test("a v2 Fast Transfer keeps maxFee by default; a Standard Transfer keeps nothing", async () => {
  const cctp = simulator();
  await burnV2(1_000_000n, 100n, 1000, "0xabcd");
  await burnV2(2_000_000n, 300n, 2000);
  const fills = await cctp.settle();
  expect(fills.map((x) => x.outputAmount)).toEqual([999_900n, 2_000_000n]);
  expect(fills[0]?.deposit.args).toMatchObject({
    version: 2,
    minFinalityThreshold: 1000,
    hookData: "0xabcd",
  });
  expect(await coinOf(bob)).toBe(2_999_900n);
});

test("fee: a custom fee is kept, and a fee above maxFee fails loudly", async () => {
  const custom = simulator({ fee: () => 40n });
  await burnV2(1_000_000n, 100n, 1000);
  const fills = await custom.settle();
  expect(fills[0]?.outputAmount).toBe(999_960n);

  const greedy = simulator({ fee: () => 101n });
  await burnV2(1_000_000n, 100n, 1000);
  await expect(greedy.settle()).rejects.toThrow(/fee 101 .* is outside 0 to min\(maxFee 100/);
  expect(greedy.pending).toHaveLength(1);
});

test("both versions settle in one call, and the journal names v1 by domain and nonce", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forkit-cctp-"));
  try {
    const cctp = simulator({ journalDir: dir });
    await burnV1(42n, 5n);
    await burnV2(6n, 0n, 2000);
    expect(await cctp.settle()).toHaveLength(2);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toBe(`cctp-v1-${ORIGIN_DOMAIN}-42.json`);
    expect(files[1]).toMatch(/^cctp-v2-31337-0x[0-9a-f]{64}-\d+\.json$/);
    const entry = JSON.parse(
      readFileSync(join(dir, files[0] as string), "utf8"),
    ) as FillJournalEntry;
    expect(entry).toMatchObject({
      status: "filled",
      outputAmount: "5",
      destinationChainId: otherChain.id,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a domain with no chain id fails and names the option", async () => {
  const cctp = simulator();
  await burnV1(1n, 5n, pad(bob), 999);
  await expect(cctp.settle()).rejects.toThrow(/domain 999, which has no chain id. Pass domains/);
});

test("a destination chain that is not forked follows unforkedDestination", async () => {
  const reject = simulator();
  const deliver = simulator({ unforkedDestination: "deliver" });
  await burnV1(1n, 5n, pad(bob), BASE_DOMAIN);
  await expect(reject.settle()).rejects.toThrow(/destination chain 8453 is not in this fork/);
  const [delivered] = await deliver.settle();
  expect(delivered).toMatchObject({ destinationChainId: 8453, unforked: true, txHashes: [] });
});

test("a recipient that is not an EVM address fails loudly", async () => {
  const cctp = simulator();
  await burnV1(1n, 5n, `0x${"11".repeat(32)}`);
  await expect(cctp.settle()).rejects.toThrow(/mintRecipient 0x1111.* is not an EVM address/);
  expect(await coinOf(bob)).toBe(0n);
});

test("usdc names the destination token, with no read of the minter", async () => {
  const cctp = simulator({ usdc: { [otherChain.id]: coin } });
  await f.prank(alice, (c) =>
    c.writeContract({
      address: messenger,
      abi: cctpMessengerStubAbi,
      functionName: "burnV1",
      // A destination messenger with no code: a minter read would fail.
      args: [1n, burnToken, 9n, pad(bob), DESTINATION_DOMAIN, pad(zeroAddress)],
    }),
  );
  await cctp.settle();
  expect(await coinOf(bob)).toBe(9n);
});

test("a minter with no local token fails and names the usdc option", async () => {
  await f.on(otherChain).prank(alice, (c) =>
    c.writeContract({
      address: messenger,
      abi: cctpMessengerStubAbi,
      functionName: "setLocalToken",
      args: [zeroAddress],
    }),
  );
  const cctp = simulator();
  await burnV1(1n, 5n);
  await expect(cctp.settle()).rejects.toThrow(/has no local token .* Pass usdc/);
});

test("refuses a fork with no TokenMessenger, a messenger with no domain, and a shared domain", () => {
  expect(() => bridge.cctp(f)).toThrow(CctpError);
  expect(() => bridge.cctp(f, { tokenMessengers: { [foundry.id]: messenger } })).toThrow(
    /no CCTP domain for it. Pass domains: \{ 31337: domain \}/,
  );
  expect(() =>
    bridge.cctp(f, { tokenMessengers: { [foundry.id]: messenger }, domains: { [foundry.id]: 6 } }),
  ).toThrow(/domain 6 is given to chains/);
});
