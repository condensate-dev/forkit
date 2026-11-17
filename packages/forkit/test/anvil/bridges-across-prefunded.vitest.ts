import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Address,
  getAddress,
  type Hex,
  keccak256,
  parseEther,
  toHex,
  zeroAddress,
} from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  AcrossPrefundedError,
  acrossPrefundedAdapterAbi,
  bridge,
  type FillJournalEntry,
} from "../../src/bridges/index.ts";
import { type Fork, fork, type SnapshotId } from "../../src/index.ts";
import { COIN_BYTECODE, coinAbi } from "../fixtures/coin.ts";
import { PREFUNDING_EMITTER_RUNTIME } from "../fixtures/prefunding.ts";
import { alice, startUpstreams } from "./adapter-contract.ts";
import { otherChain } from "./upstream.ts";

// bridge.acrossPrefunded on two local anvils. The origin has a contract that emits what Across's
// PrefundedAdapter emits from store(); the destination has a plain ERC-20.

const adapter: Address = "0x000000000000000000000000000000000000ad47";
const bob = getAddress("0x0000000000000000000000000000000000000b0b");
/** The token named in the origin event. Nothing reads it on the origin. */
const inputToken = getAddress("0x0000000000000000000000000000000000001234");
const orderId = (name: string): Hex => keccak256(toHex(`forkit prefunded order ${name}`));

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
  await f.client.setCode({ address: adapter, bytecode: PREFUNDING_EMITTER_RUNTIME });
  const other = f.on(otherChain);
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
  await f.dealNative(alice, parseEther("100"));
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

const simulator = (options: Partial<Parameters<typeof bridge.acrossPrefunded>[1]> = {}) =>
  bridge.acrossPrefunded(f, { adapters: { [foundry.id]: adapter }, ...options });

const store = (id: Hex, amount: bigint, value = 0n) =>
  f.prank(alice, (c) =>
    c.writeContract({
      address: adapter,
      abi: acrossPrefundedAdapterAbi,
      functionName: "store",
      args: [id, inputToken, amount],
      value,
    }),
  );

const coinOf = (holder: Address) =>
  f.on(otherChain).client.readContract({
    address: coin,
    abi: coinAbi,
    functionName: "balanceOf",
    args: [holder],
  });

test("an ERC-20 order: the relayer pays the registered amount to the recipient", async () => {
  const b = simulator();
  const id = orderId("erc20");
  b.expect(id, {
    destinationChainId: otherChain.id,
    token: coin,
    amount: 990_000n,
    recipient: bob,
  });
  await store(id, 1_000_000n);
  const [found] = await b.poll();
  expect(found?.args).toEqual({ orderId: id, token: inputToken, amount: 1_000_000n });
  expect(found?.destinationChainId).toBe(otherChain.id);

  const fills = await b.settle();
  expect(fills).toHaveLength(1);
  expect(fills[0]).toMatchObject({
    destinationChainId: otherChain.id,
    outputAmount: 990_000n,
    details: {
      orderId: id,
      relayer: b.relayer,
      inputToken,
      inputAmount: 1_000_000n,
      recipient: bob,
      token: coin,
      outputAmount: 990_000n,
      topUp: false,
    },
  });
  expect(fills[0]?.txHashes).toHaveLength(1);
  expect(await coinOf(bob)).toBe(990_000n);
  // The relayer was dealt what it paid, and no more.
  expect(await coinOf(b.relayer)).toBe(0n);
  expect(await b.settle()).toEqual([]);
});

test("a native order: the zero address pays native currency", async () => {
  const b = simulator();
  const id = orderId("native");
  b.expect(id, {
    destinationChainId: otherChain.id,
    token: zeroAddress,
    amount: parseEther("0.5"),
    recipient: bob,
  });
  await store(id, 0n, parseEther("0.6"));
  expect((await b.poll())[0]?.args).toEqual({
    orderId: id,
    token: zeroAddress,
    amount: parseEther("0.6"),
  });
  await b.settle();
  expect(await f.on(otherChain).client.getBalance({ address: bob })).toBe(parseEther("0.5"));
});

test("an order is paid once: a later store for it is a top-up", async () => {
  const b = simulator();
  const id = orderId("top-up");
  b.expect(id, { destinationChainId: otherChain.id, token: coin, amount: 500n, recipient: bob });
  // One transaction, two events: the token, then the native currency sent along.
  await store(id, 400n, 7n);
  await store(id, 100n);
  const fills = await b.settle();
  expect(fills.map((x) => x.details?.topUp)).toEqual([false, true, true]);
  expect(fills.map((x) => x.txHashes.length)).toEqual([1, 0, 0]);
  expect(fills.map((x) => x.outputAmount)).toEqual([500n, 0n, 0n]);
  expect(await coinOf(bob)).toBe(500n);
});

test("after an evm_revert undid the paying deposit, the order is paid again", async () => {
  const b = simulator();
  const id = orderId("revert");
  b.expect(id, { destinationChainId: otherChain.id, token: coin, amount: 500n, recipient: bob });
  const before = await Promise.all(f.forks.map((g) => g.snapshot()));
  await store(id, 500n);
  await b.settle();
  expect(await coinOf(bob)).toBe(500n);
  await Promise.all(f.forks.map((g, i) => g.revertTo(before[i] as SnapshotId)));
  expect(await coinOf(bob)).toBe(0n);
  await store(id, 500n);
  const fills = await b.settle();
  expect(fills.map((x) => x.details?.topUp)).toEqual([false]);
  expect(await coinOf(bob)).toBe(500n);
});

test("an order id with no registered order fails loudly, then fills once registered", async () => {
  const b = simulator();
  const id = orderId("unknown");
  await store(id, 1n);
  const error = await b.settle().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AcrossPrefundedError);
  expect((error as Error).message).toContain(
    `a PrefundingStored event on chain ${foundry.id} carries order id ${id}`,
  );
  expect((error as Error).message).toContain("b.expect(");
  b.expect(id, { destinationChainId: otherChain.id, token: coin, amount: 1n, recipient: bob });
  expect(await b.settle()).toHaveLength(1);
});

test("orders can be registered through the options, and the journal is named by the order id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forkit-journal-"));
  try {
    const id = orderId("journal");
    const b = simulator({
      journalDir: dir,
      orders: {
        [id]: { destinationChainId: otherChain.id, token: coin, amount: 5n, recipient: bob },
      },
    });
    await store(id, 5n);
    const [fill] = await b.settle();
    expect(readdirSync(dir)).toEqual([`across-prefunded-${id}.json`]);
    const entry = JSON.parse(
      readFileSync(join(dir, `across-prefunded-${id}.json`), "utf8"),
    ) as FillJournalEntry;
    expect(entry).toMatchObject({
      status: "filled",
      bridge: "across-prefunded",
      key: id,
      destinationChainId: otherChain.id,
      destinationTxHashes: fill?.txHashes,
      outputAmount: "5",
      deposit: { args: { witness: id, token: inputToken, amount: "5" } },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses no adapter, a bad order id, and a destination that is not forked", () => {
  expect(() => bridge.acrossPrefunded(f, { adapters: {} })).toThrow(
    /needs the PrefundedAdapter of each origin chain/,
  );
  const b = simulator();
  const order = { destinationChainId: otherChain.id, token: coin, amount: 1n, recipient: bob };
  expect(() => b.expect("0x1234", order)).toThrow(/is not a bytes32/);
  expect(() => b.expect(orderId("x"), { ...order, destinationChainId: 10 })).toThrow(
    /destination chain 10 is not in this fork/,
  );
  expect(() => b.expect(orderId("x"), { ...order, amount: -1n })).toThrow(/cannot be negative/);
  // With a rule for chains that are not forked, the same order is taken.
  expect(() =>
    simulator({ unforkedDestination: "deliver" }).expect(orderId("x"), {
      ...order,
      destinationChainId: 10,
    }),
  ).not.toThrow();
});
