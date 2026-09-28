import { type Address, getAbiItem, parseEther } from "viem";
import { foundry, mainnet } from "viem/chains";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { bridge } from "../../src/bridges/index.ts";
import { type Fork, fork, type SnapshotId } from "../../src/index.ts";
import { VAULT_BYTECODE, vaultAbi } from "../fixtures/vault.ts";
import { alice, startUpstreams } from "./adapter-contract.ts";
import { otherChain } from "./upstream.ts";

const FEE = 1_000n;
let upstreams: Awaited<ReturnType<typeof startUpstreams>>;
let f: Fork<typeof foundry>;
let vault: Address;
let snapshots: [Fork, SnapshotId][] = [];

beforeAll(async () => {
  upstreams = await startUpstreams();
  f = await fork([
    { chain: foundry, forkUrl: upstreams.a.url, blockNumber: 0n, cache: "off" },
    { chain: otherChain, forkUrl: upstreams.b.url, blockNumber: 0n, cache: "off" },
  ]);
  const [deployer] = await f.client.getAddresses();
  const hash = await f.client.deployContract({
    abi: vaultAbi,
    bytecode: VAULT_BYTECODE,
    account: deployer as Address,
  });
  vault = (await f.client.waitForTransactionReceipt({ hash })).contractAddress as Address;
  await f.dealNative(alice, parseEther("10"));
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

/** A toy bridge: a Vault deposit on 31337 is paid out, minus a fee, in native currency on 31338. */
const toyBridge = () =>
  bridge.custom(f, {
    originEvent: {
      event: getAbiItem({ abi: vaultAbi, name: "Deposited" }),
      address: { [foundry.id]: vault },
    },
    destinationOf: () => otherChain.id,
    onDeposit: async ({ deposit, destination }) => {
      const { account, amount } = deposit.args as { account: Address; amount: bigint };
      const before = await destination.client.getBalance({ address: account });
      await destination.dealNative(account, before + amount - FEE);
      return { outputAmount: amount - FEE, details: { fee: FEE } };
    },
  });

const deposit = (value: bigint) =>
  f.prank(alice, (c) =>
    c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value }),
  );

test("settle() fills every pending deposit on the destination, in order", async () => {
  const b = toyBridge();
  await deposit(parseEther("1"));
  await deposit(parseEther("2"));
  expect((await b.poll()).map((d) => d.args)).toEqual([
    { account: expect.stringMatching(/^0x/i), amount: parseEther("1") },
    { account: expect.stringMatching(/^0x/i), amount: parseEther("2") },
  ]);
  expect(b.pending).toHaveLength(2);
  const fills = await b.settle();
  expect(fills.map((x) => x.outputAmount)).toEqual([parseEther("1") - FEE, parseEther("2") - FEE]);
  expect(fills[0]?.deposit).toMatchObject({
    originChainId: foundry.id,
    destinationChainId: otherChain.id,
  });
  expect(b.pending).toHaveLength(0);
  expect(await f.on(otherChain).client.getBalance({ address: alice })).toBe(
    parseEther("3") - 2n * FEE,
  );
  expect(await b.settle()).toEqual([]);
  expect(b.fills).toHaveLength(2);
});

test("ignores deposits made before the simulator existed", async () => {
  await deposit(parseEther("1"));
  const b = toyBridge();
  expect(await b.settle()).toEqual([]);
});

test("forgets deposits an evm_revert undid", async () => {
  const b = toyBridge();
  const id = await f.snapshot();
  await deposit(parseEther("1"));
  expect(await b.poll()).toHaveLength(1);
  await f.revertTo(id);
  expect(await b.settle()).toEqual([]);
  expect(b.pending).toHaveLength(0);
  await deposit(parseEther("4"));
  expect((await b.settle()).map((x) => x.outputAmount)).toEqual([parseEther("4") - FEE]);
});

test("a revert re-mined back to the same height: the undone deposit is dropped, the new one filled", async () => {
  // The review's repro: no poll between the revert and the new deposit, and the chain is back
  // at the height the simulator last scanned, so heights alone cannot see the revert.
  const b = toyBridge();
  const id = await f.snapshot();
  await deposit(parseEther("1"));
  expect(await b.poll()).toHaveLength(1);
  await f.revertTo(id);
  await deposit(parseEther("2"));
  const fills = await b.settle();
  expect(fills.map((x) => x.outputAmount)).toEqual([parseEther("2") - FEE]);
  expect(b.pending).toHaveLength(0);
});

test("a deposit made after a revert is found even when the undone one was already settled", async () => {
  const b = toyBridge();
  const id = await f.snapshot();
  await deposit(parseEther("1"));
  expect((await b.settle()).map((x) => x.outputAmount)).toEqual([parseEther("1") - FEE]);
  await f.revertTo(id);
  await deposit(parseEther("5"));
  expect((await b.settle()).map((x) => x.outputAmount)).toEqual([parseEther("5") - FEE]);
});

test("concurrent settle() calls fill each deposit once", async () => {
  let calls = 0;
  const b = bridge.custom(f, {
    originEvent: {
      event: getAbiItem({ abi: vaultAbi, name: "Deposited" }),
      address: { [foundry.id]: vault },
    },
    destinationOf: () => otherChain.id,
    onDeposit: async () => {
      calls++;
      await new Promise((ok) => setTimeout(ok, 50));
      return undefined;
    },
  });
  await deposit(parseEther("1"));
  const [one, two] = await Promise.all([b.settle(), b.settle()]);
  expect(one.length + two.length).toBe(1);
  expect(calls).toBe(1);
});

test("refuses a chain that is not in the fork", () => {
  expect(() =>
    bridge.custom(f, {
      originEvent: {
        event: getAbiItem({ abi: vaultAbi, name: "Deposited" }),
        address: { [mainnet.id]: vault },
      },
      destinationOf: () => otherChain.id,
      onDeposit: async () => undefined,
    }),
  ).toThrow(/origin chain 1 is not in this fork/);
});
