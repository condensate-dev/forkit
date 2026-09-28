import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, parseEther } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Fork, ForkitAssertionError, fork, parseGasSnapshot } from "../../src/index.ts";
import { VAULT_BYTECODE, vaultAbi } from "../fixtures/vault.ts";
import { startUpstream } from "./upstream.ts";

const alice: Address = "0x00000000000000000000000000000000000a11ce";
const dir = mkdtempSync(join(tmpdir(), "forkit-gas-"));
const file = join(dir, ".gas-snapshot");

let upstream: Awaited<ReturnType<typeof startUpstream>>;
let writer: Fork<typeof foundry>;
let vault: Address;

const target = (mode: "write" | "check") =>
  ({
    chain: foundry,
    forkUrl: upstream.url,
    blockNumber: 0n,
    cache: "off",
    gasSnapshot: mode,
    gasSnapshotFile: file,
  }) as const;

const deposit = (f: Fork<typeof foundry>, value: bigint) =>
  f.prank(alice, (c) =>
    c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value }),
  );

beforeAll(async () => {
  upstream = await startUpstream();
  writer = await fork(target("write"));
  const [deployer] = await writer.client.getAddresses();
  const hash = await writer.client.deployContract({
    abi: vaultAbi,
    bytecode: VAULT_BYTECODE,
    account: deployer as Address,
  });
  vault = (await writer.client.waitForTransactionReceipt({ hash })).contractAddress as Address;
  await writer.dealNative(alice, parseEther("10"));
});

afterAll(async () => {
  await writer?.stop();
  await upstream?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("records gas under a label, from a hash, a promise, a receipt or a function", async () => {
  const hash = await deposit(writer, 1n);
  const receipt = await writer.client.getTransactionReceipt({ hash });
  expect(await writer.gasSnapshot("first deposit", hash)).toBe(receipt.gasUsed);
  expect(await writer.gasSnapshot("receipt form", receipt)).toBe(receipt.gasUsed);
  const second = await writer.gasSnapshot("second deposit", () => deposit(writer, 1n));
  expect(await writer.gasSnapshot("promise form", deposit(writer, 1n))).toBe(second);
  // The first deposit also writes the Ledger's slot from zero, so it costs more.
  expect(receipt.gasUsed).toBeGreaterThan(second);
  expect([...parseGasSnapshot(readFileSync(file, "utf8")).keys()]).toEqual([
    "first deposit",
    "promise form",
    "receipt form",
    "second deposit",
  ]);
});

test("check mode passes on the same gas and fails, with the delta, when it moves", async () => {
  const checker = await fork(target("check"));
  try {
    const [deployer] = await checker.client.getAddresses();
    const hash = await checker.client.deployContract({
      abi: vaultAbi,
      bytecode: VAULT_BYTECODE,
      account: deployer as Address,
    });
    expect((await checker.client.waitForTransactionReceipt({ hash })).contractAddress).toBe(vault);
    await checker.dealNative(alice, parseEther("10"));
    await checker.gasSnapshot("first deposit", () => deposit(checker, 1n));
    // A repeat deposit is cheaper than the recorded first one.
    const failure = await checker
      .gasSnapshot("first deposit", () => deposit(checker, 1n))
      .catch((e) => e);
    expect(failure).toBeInstanceOf(ForkitAssertionError);
    expect(failure.message).toMatch(
      /gas for "first deposit" changed: \d+ → \d+, -\d+ \(-\d+\.\d+%\)/,
    );
    await expect(checker.gasSnapshot("never recorded", () => deposit(checker, 1n))).rejects.toThrow(
      /no gas snapshot/,
    );
  } finally {
    await checker.stop();
  }
});
