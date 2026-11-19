import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, getAbiItem, parseEther } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  type BridgeSimulatorOptions,
  bridge,
  type FillJournalEntry,
  fillJournalFile,
} from "../../src/bridges/index.ts";
import { type Fork, fork, type SnapshotId } from "../../src/index.ts";
import { VAULT_BYTECODE, vaultAbi } from "../fixtures/vault.ts";
import { alice, startUpstreams } from "./adapter-contract.ts";
import { otherChain } from "./upstream.ts";

// What a long-running stack needs from a bridge simulator: a settle loop, a fill journal that
// another process reads, a bounded retry, and a rule for a destination that is not forked.

/** A deposit of this amount makes the toy bridge's fill throw. */
const POISON = parseEther("13");
/** A chain id that is in no fork here. */
const UNFORKED = 424_242;

let upstreams: Awaited<ReturnType<typeof startUpstreams>>;
let f: Fork<typeof foundry>;
let vault: Address;
let snapshots: [Fork, SnapshotId][] = [];
let dir: string;

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
  await f.dealNative(alice, parseEther("100"));
});

beforeEach(async () => {
  await Promise.all(snapshots.map(([g, id]) => g.revertTo(id)));
  snapshots = await Promise.all(
    f.forks.map(async (g): Promise<[Fork, SnapshotId]> => [g, await g.snapshot()]),
  );
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "forkit-journal-"));
});

afterAll(async () => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  await f?.stop();
  await upstreams?.stop();
});

/**
 * A toy bridge: a Vault deposit on 31337 is paid out in native currency on 31338. A deposit of
 * an odd number of wei goes to a chain that is not forked.
 */
const toyBridge = (options: BridgeSimulatorOptions = {}) =>
  bridge.custom(f, {
    name: "toy",
    originEvent: {
      event: getAbiItem({ abi: vaultAbi, name: "Deposited" }),
      address: { [foundry.id]: vault },
    },
    destinationOf: (args: { account: Address; amount: bigint }) =>
      args.amount % 2n === 1n ? UNFORKED : otherChain.id,
    onDeposit: async ({ deposit, destination }) => {
      const { account, amount } = deposit.args;
      if (amount === POISON) throw new Error("the toy relayer refuses 13 ether");
      const before = await destination.client.getBalance({ address: account });
      await destination.dealNative(account, before + amount);
      return { outputAmount: amount, details: { fee: 0n } };
    },
    ...options,
  });

const deposit = (value: bigint) =>
  f.prank(alice, (c) =>
    c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value }),
  );

const balanceOnOther = () => f.on(otherChain).client.getBalance({ address: alice });

/** The journal files in `dir`, parsed, by file name. */
function journal(): Record<string, FillJournalEntry> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((file) => [file, JSON.parse(readFileSync(join(dir, file), "utf8")) as FillJournalEntry]),
  );
}

test("without maxFillAttempts, a failing deposit stays pending and holds the ones behind it", async () => {
  const b = toyBridge();
  await deposit(POISON);
  await deposit(parseEther("2"));
  await expect(b.settle()).rejects.toThrow("the toy relayer refuses 13 ether");
  await expect(b.settle()).rejects.toThrow("the toy relayer refuses 13 ether");
  expect(b.pending).toHaveLength(2);
  expect(b.failed).toEqual([]);
  expect(await balanceOnOther()).toBe(0n);
});

test("maxFillAttempts: 1 gives a failing deposit up at once and fills the ones behind it", async () => {
  const b = toyBridge({ maxFillAttempts: 1 });
  await deposit(parseEther("1"));
  await deposit(POISON);
  await deposit(parseEther("2"));
  await expect(b.settle()).rejects.toThrow("the toy relayer refuses 13 ether");
  expect(b.pending).toEqual([]);
  expect(b.fills.map((x) => x.outputAmount)).toEqual([parseEther("1"), parseEther("2")]);
  expect(b.failed).toHaveLength(1);
  expect(b.failed[0]).toMatchObject({
    attempts: 1,
    deposit: { args: { amount: POISON }, destinationChainId: otherChain.id },
  });
  expect(await balanceOnOther()).toBe(parseEther("3"));
  // It is not tried again.
  expect(await b.settle()).toEqual([]);
  expect(b.failed).toHaveLength(1);
});

test("maxFillAttempts: 3 tries three settles, then gives the deposit up", async () => {
  const b = toyBridge({ maxFillAttempts: 3, journalDir: dir });
  await deposit(POISON);
  await deposit(parseEther("2"));
  expect(Object.keys(journal())).toEqual([]);
  for (const attempts of [1, 2]) {
    await expect(b.settle()).rejects.toThrow("the toy relayer refuses 13 ether");
    expect(b.pending).toHaveLength(2);
    expect(Object.values(journal())).toMatchObject([
      { status: "failed", attempts, retrying: true },
    ]);
  }
  await expect(b.settle()).rejects.toThrow("the toy relayer refuses 13 ether");
  expect(b.pending).toEqual([]);
  expect(b.failed.map((x) => x.attempts)).toEqual([3]);
  expect(b.fills.map((x) => x.outputAmount)).toEqual([parseEther("2")]);
  expect(
    Object.values(journal())
      .map((entry) => entry.status)
      .sort(),
  ).toEqual(["failed", "filled"]);
});

test("several deposits given up in one settle reject with one AggregateError", async () => {
  const b = toyBridge({ maxFillAttempts: 1 });
  await deposit(POISON);
  await deposit(POISON);
  const error = await b.settle().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toHaveLength(2);
  expect((error as AggregateError).message).toMatch(/2 bridge deposits failed/);
});

test("maxFillAttempts must be a whole number, 1 or more", () => {
  expect(() => toyBridge({ maxFillAttempts: 0 })).toThrow(/maxFillAttempts is 0/);
  expect(() => toyBridge({ maxFillAttempts: 1.5 })).toThrow(/maxFillAttempts is 1.5/);
});

test("the journal has one file per deposit: the fill, or the error of a failed one", async () => {
  const b = toyBridge({ journalDir: dir, maxFillAttempts: 1 });
  const filledTx = await deposit(parseEther("2"));
  const failedTx = await deposit(POISON);
  await expect(b.settle()).rejects.toThrow();
  const [fill] = b.fills;
  const [failure] = b.failed;
  if (fill === undefined || failure === undefined) throw new Error("expected a fill and a failure");

  const entries = journal();
  // Named from the bridge and the deposit id, and no temporary file is left behind.
  expect(Object.keys(entries).sort()).toEqual(
    [
      `toy-${foundry.id}-${filledTx}-${fill.deposit.logIndex}.json`,
      `toy-${foundry.id}-${failedTx}-${failure.deposit.logIndex}.json`,
    ].sort(),
  );
  const filled = entries[`toy-${foundry.id}-${filledTx}-${fill.deposit.logIndex}.json`];
  expect(filled).toEqual({
    version: 1,
    bridge: "toy",
    key: fill.deposit.id,
    deposit: {
      id: fill.deposit.id,
      originChainId: foundry.id,
      txHash: filledTx,
      blockNumber: fill.deposit.blockNumber.toString(),
      blockHash: fill.deposit.blockHash,
      logIndex: fill.deposit.logIndex,
      address: fill.deposit.address,
      args: { account: fill.deposit.args.account, amount: parseEther("2").toString() },
    },
    updatedAt: expect.any(Number),
    status: "filled",
    destinationChainId: otherChain.id,
    destinationTxHashes: [],
    outputAmount: parseEther("2").toString(),
    details: { fee: "0" },
  });
  const failed = entries[`toy-${foundry.id}-${failedTx}-${failure.deposit.logIndex}.json`];
  expect(failed).toMatchObject({
    status: "failed",
    bridge: "toy",
    destinationChainId: otherChain.id,
    deposit: { txHash: failedTx, args: { amount: POISON.toString() } },
    error: { name: "Error", message: "the toy relayer refuses 13 ether" },
    attempts: 1,
    retrying: false,
  });
  expect(fillJournalFile(dir, "toy", fill.deposit.id)).toBe(
    join(dir, `toy-${foundry.id}-${filledTx}-${fill.deposit.logIndex}.json`),
  );
});

test("journalKey names the file by the bridge's own id", async () => {
  const b = bridge.custom(f, {
    name: "toy",
    originEvent: {
      event: getAbiItem({ abi: vaultAbi, name: "Deposited" }),
      address: { [foundry.id]: vault },
    },
    destinationOf: () => otherChain.id,
    onDeposit: async () => undefined,
    journalDir: dir,
    journalKey: (d) => `order-${(d.args as { amount: bigint }).amount}`,
  });
  await deposit(7n);
  await b.settle();
  expect(Object.keys(journal())).toEqual(["toy-order-7.json"]);
  expect(journal()["toy-order-7.json"]).toMatchObject({ key: "order-7", status: "filled" });
});

test("a destination that is not forked: reject is the default, and names the option", async () => {
  const b = toyBridge();
  await deposit(3n);
  await expect(b.settle()).rejects.toThrow(
    new RegExp(`destination chain ${UNFORKED} is not in this fork.*unforkedDestination`),
  );
  expect(b.pending).toHaveLength(1);
});

test("unforkedDestination: skip drops the deposit and fills the ones behind it", async () => {
  const b = toyBridge({ unforkedDestination: "skip", journalDir: dir });
  await deposit(3n);
  await deposit(parseEther("2"));
  const fills = await b.settle();
  expect(fills.map((x) => x.outputAmount)).toEqual([parseEther("2")]);
  expect(b.pending).toEqual([]);
  expect(b.failed).toEqual([]);
  expect(Object.values(journal()).map((entry) => entry.status)).toEqual(["filled"]);
});

test("unforkedDestination: deliver records a fill with no transaction, and journals it", async () => {
  const b = toyBridge({ unforkedDestination: "deliver", journalDir: dir });
  const tx = await deposit(3n);
  await deposit(parseEther("2"));
  const fills = await b.settle();
  expect(fills).toHaveLength(2);
  expect(fills[0]).toMatchObject({ destinationChainId: UNFORKED, txHashes: [], unforked: true });
  expect(fills[0]?.outputAmount).toBeUndefined();
  expect(fills[1]?.unforked).toBeUndefined();
  const entry = Object.values(journal()).find((e) => e.deposit.txHash === tx);
  expect(entry).toMatchObject({
    status: "unforked",
    destinationChainId: UNFORKED,
    destinationTxHashes: [],
  });
  expect(await balanceOnOther()).toBe(parseEther("2"));
});

test("bridge.run settles on an interval until stopped, and reports a failed fill", async () => {
  const errors: unknown[] = [];
  const b = toyBridge({ maxFillAttempts: 1, journalDir: dir });
  const stop = bridge.run([b], { intervalMs: 20, onError: (error) => errors.push(error) });
  try {
    await deposit(parseEther("1"));
    await deposit(POISON);
    await deposit(parseEther("2"));
    await expect.poll(balanceOnOther, { timeout: 5_000, interval: 20 }).toBe(parseEther("3"));
    // The loop goes on after the error: a later deposit is filled too.
    await deposit(parseEther("4"));
    await expect.poll(balanceOnOther, { timeout: 5_000, interval: 20 }).toBe(parseEther("7"));
  } finally {
    await stop();
  }
  expect(errors).toEqual([new Error("the toy relayer refuses 13 ether")]);
  expect(b.fills).toHaveLength(3);
  expect(
    Object.values(journal())
      .map((entry) => entry.status)
      .sort(),
  ).toEqual(["failed", "filled", "filled", "filled"]);
  // Stopped: a deposit made now stays where it is.
  await deposit(parseEther("8"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await balanceOnOther()).toBe(parseEther("7"));
});
