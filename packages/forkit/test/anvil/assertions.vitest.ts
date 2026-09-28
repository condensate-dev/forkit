import { type Address, encodeFunctionData, getAbiItem, parseEther } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  clearLabels,
  expectBalanceChange,
  expectEmit,
  expectRevert,
  type Fork,
  ForkitAssertionError,
  fork,
  formatAddress,
  NATIVE,
  registerAbi,
  traceOf,
} from "../../src/index.ts";
import { PLAIN_TOKEN_RUNTIME } from "../fixtures/tokens.ts";
import { ledgerAbi, VAULT_BYTECODE, vaultAbi } from "../fixtures/vault.ts";
import { startUpstream } from "./upstream.ts";

const alice: Address = "0x00000000000000000000000000000000000a11ce";
const bob: Address = "0x0000000000000000000000000000000000000b0b";
const token: Address = "0x00000000000000000000000000000000000070a1";

let upstream: Awaited<ReturnType<typeof startUpstream>>;
let f: Fork<typeof foundry>;
let quiet: Fork<typeof foundry>;
let vault: Address;
let ledger: Address;
let snapshot: `0x${string}`;

async function deployVault(on: Fork<typeof foundry>): Promise<Address> {
  const [deployer] = await on.client.getAddresses();
  if (deployer === undefined) throw new Error("anvil has no dev accounts");
  const hash = await on.client.deployContract({
    abi: vaultAbi,
    bytecode: VAULT_BYTECODE,
    account: deployer,
  });
  const receipt = await on.client.waitForTransactionReceipt({ hash });
  if (receipt.contractAddress == null) throw new Error("Vault did not deploy");
  return receipt.contractAddress;
}

beforeAll(async () => {
  upstream = await startUpstream();
  f = await fork({ chain: foundry, forkUrl: upstream.url, blockNumber: 0n, cache: "off" });
  quiet = await fork({
    chain: foundry,
    forkUrl: upstream.url,
    blockNumber: 0n,
    cache: "off",
    traces: "off",
  });
  vault = await deployVault(f);
  ledger = await f.client.readContract({ address: vault, abi: vaultAbi, functionName: "ledger" });
  await f.dealNative(alice, parseEther("10"));
  await f.client.setCode({ address: token, bytecode: PLAIN_TOKEN_RUNTIME });
  snapshot = await f.snapshot();
});

beforeEach(async () => {
  clearLabels();
  registerAbi(vaultAbi);
  registerAbi(ledgerAbi);
  f.label(vault, "Vault");
  f.label(ledger, "Ledger");
  f.label(alice, "alice");
  f.label(bob, "bob");
  await f.revertTo(snapshot);
  snapshot = await f.snapshot();
});

afterAll(async () => {
  await f?.stop();
  await quiet?.stop();
  await upstream?.stop();
});

const deposit = (value: bigint) =>
  f.prank(alice, (c) =>
    c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value }),
  );
const withdraw = (to: Address, amount: bigint) =>
  f.prank(alice, (c) =>
    c.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [to, amount],
    }),
  );

describe("expectRevert", () => {
  test("matches a reason string exactly", async () => {
    const revert = await expectRevert(deposit(0n), "Vault: zero deposit");
    expect(revert).toMatchObject({ kind: "reason", reason: "Vault: zero deposit" });
  });

  test("matches a custom error by signature, selector, or ABI with args", async () => {
    await expectRevert(withdraw(bob, 1n), "InsufficientBalance(address,uint256,uint256)");
    const revert = await expectRevert(withdraw(bob, 1n), {
      abi: vaultAbi,
      errorName: "InsufficientBalance",
      args: [alice, 0n, 1n],
    });
    expect(revert.selector).toMatch(/^0x[0-9a-f]{8}$/);
    await expectRevert(withdraw(bob, 1n), revert.selector);
  });

  test("decodes panics and reverts from a nested call", async () => {
    await expectRevert(
      f.client.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "ratio",
        args: [1n, 0n],
      }),
      /division or modulo by zero/,
    );
    await expectRevert(
      f.client.readContract({ address: vault, abi: vaultAbi, functionName: "audit", args: [5n] }),
      "Ledger: not enough entries",
    );
  });

  test("a different revert fails with expected, actual and the trace", async () => {
    const failure = await expectRevert(withdraw(bob, 1n), "Vault: zero deposit").catch((e) => e);
    expect(failure).toBeInstanceOf(ForkitAssertionError);
    expect(failure.message).toContain(
      `expected Error("Vault: zero deposit"), got InsufficientBalance(${formatAddress(alice)}, 0, 1)`,
    );
    expect(formatAddress(alice)).toBe("alice (0x0000…11cE)");
    expect(failure.message).toContain(`Vault::withdraw(${formatAddress(bob)}, 1)`);
    expect(failure.expected).toBe("Vault: zero deposit");
  });

  test("fails when the call succeeds", async () => {
    await expect(expectRevert(deposit(1n))).rejects.toThrow(
      /expected a revert, but the call succeeded/,
    );
  });

  test("fails when the call fails for a reason other than a revert", async () => {
    await expect(expectRevert(Promise.reject(new Error("socket hang up")))).rejects.toThrow(
      /failed another way: socket hang up/,
    );
  });

  test("decodes a mined, reverted transaction's receipt through a trace", async () => {
    const receipt = await f.prank(alice, async (c) => {
      const hash = await c.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "deposit",
        value: 0n,
        gas: 200_000n,
      });
      return await c.waitForTransactionReceipt({ hash });
    });
    expect(receipt.status).toBe("reverted");
    await expectRevert(Promise.resolve(receipt), "Vault: zero deposit", { client: f.client });
  });
});

describe("traces on failure", () => {
  test("a reverted write carries a decoded, labelled trace", async () => {
    const error = await withdraw(bob, parseEther("1")).catch((e) => e);
    const trace = traceOf(error);
    expect(trace).toContain(`Vault::withdraw(${formatAddress(bob)}, 1000000000000000000)`);
    expect(trace).toContain(
      `← [Revert] InsufficientBalance(${formatAddress(alice)}, 0, 1000000000000000000)`,
    );
    expect(error.message).toContain("Trace (forkit, replayed with debug_traceCall)");
  });

  test("the trace shows nested calls", async () => {
    const error = await f
      .prank(alice, (c) =>
        c.sendTransaction({
          to: vault,
          data: encodeFunctionData({ abi: vaultAbi, functionName: "audit", args: [5n] }),
        }),
      )
      .catch((e) => e);
    const trace = traceOf(error) ?? "";
    expect(trace).toContain("Vault::audit(5)");
    expect(trace).toContain("Ledger::check(5) [staticcall]");
    expect(trace).toContain("├─");
    expect(trace).toContain('← [Revert] Error("Ledger: not enough entries")');
  });

  test("traces: off leaves errors alone", async () => {
    const quietVault = await deployVault(quiet);
    const error = await quiet
      .prank(alice, (c) =>
        c.writeContract({ address: quietVault, abi: vaultAbi, functionName: "deposit", value: 0n }),
      )
      .catch((e) => e);
    expect(traceOf(error)).toBeUndefined();
    expect(error.message).not.toContain("Trace (forkit");
  });

  test("f.trace() renders a mined transaction", async () => {
    const hash = await deposit(parseEther("1"));
    const trace = await f.trace(hash);
    expect(trace).toContain("Vault::deposit{value: 1 ETH}()");
    expect(trace).toMatch(
      new RegExp(
        `├─ \\[\\d+\\] Ledger::record\\(${formatAddress(alice).replace(/[()]/g, "\\$&")}, 1000000000000000000\\)`,
      ),
    );
    expect(trace).toContain("└─ ← [Stop]");
  });
});

describe("expectEmit", () => {
  const deposited = getAbiItem({ abi: vaultAbi, name: "Deposited" });

  test("finds an event, with partial args, and returns the decoded logs", async () => {
    const receipt = await f.client.waitForTransactionReceipt({ hash: await deposit(3n) });
    const [log] = expectEmit(receipt, deposited, { account: alice });
    expect(log?.args.amount).toBe(3n);
    expectEmit(receipt, deposited, { account: alice, amount: 3n }, { address: vault, count: 1 });
  });

  test("fails with the logs that were emitted, decoded and labelled", async () => {
    const receipt = await f.client.waitForTransactionReceipt({ hash: await deposit(3n) });
    const failure = (() => {
      try {
        expectEmit(receipt, deposited, { amount: 4n });
      } catch (error) {
        return error as Error;
      }
    })();
    expect(failure).toBeInstanceOf(ForkitAssertionError);
    expect(failure?.message).toContain("expected Deposited { amount: 4 } to be emitted in tx");
    expect(failure?.message).toContain(
      `${formatAddress(vault)} emitted Deposited(account: ${formatAddress(alice)}, amount: 3)`,
    );
    expect(() => expectEmit(receipt, deposited, undefined, { address: bob })).toThrow(
      ForkitAssertionError,
    );
    expect(() => expectEmit(receipt, deposited, undefined, { count: 2 })).toThrow(
      /exactly 2 time\(s\), got 1/,
    );
  });
});

describe("expectBalanceChange", () => {
  test("native and ERC-20 deltas, positive and negative", async () => {
    await deposit(parseEther("2"));
    await f.expectBalanceChange(NATIVE, bob, parseEther("0.5"), () =>
      withdraw(bob, parseEther("0.5")),
    );
    await expectBalanceChange(f.client, NATIVE, vault, -parseEther("0.5"), () =>
      withdraw(bob, parseEther("0.5")),
    );
    const result = await f.expectBalanceChange(token, alice, 5n, async () => {
      await f.deal(token, alice, 5n);
      return "dealt";
    });
    expect(result).toBe("dealt");
  });

  test("fails with before, after and the actual delta", async () => {
    await expect(
      f.expectBalanceChange(token, alice, 6n, () => f.deal(token, alice, 5n)),
    ).rejects.toThrow(
      /alice \(0x0000…11cE\)'s balance of .* to change by 6, but it changed by 5 \(0 → 5\)/,
    );
  });
});
