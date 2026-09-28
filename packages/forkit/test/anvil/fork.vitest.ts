import { type Address, parseEther } from "viem";
import { foundry, mainnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  DealError,
  erc20BalanceAbi,
  type Fork,
  ForkBootError,
  ForkitError,
  fork,
} from "../../src/index.ts";
import { PLAIN_TOKEN_RUNTIME, SHARES_TOKEN_RUNTIME } from "../fixtures/tokens.ts";
import { startUpstream } from "./upstream.ts";

const alice: Address = "0x00000000000000000000000000000000000a11ce";
const bob: Address = "0x0000000000000000000000000000000000000b0b";
const plainToken: Address = "0x00000000000000000000000000000000000070a1";
const sharesToken: Address = "0x0000000000000000000000000000000000005ba2";

let upstream: Awaited<ReturnType<typeof startUpstream>>;
let f: Fork<typeof foundry>;
const warnings: string[] = [];

beforeAll(async () => {
  upstream = await startUpstream();
  // Unpinned on purpose, to exercise the warning.
  f = await fork({
    chain: foundry,
    forkUrl: upstream.url,
    onWarn: (message) => warnings.push(message),
  });
  await f.client.setCode({ address: plainToken, bytecode: PLAIN_TOKEN_RUNTIME });
  await f.client.setCode({ address: sharesToken, bytecode: SHARES_TOKEN_RUNTIME });
});

function balanceOf(token: Address, holder: Address): Promise<bigint> {
  return f.client.readContract({
    address: token,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [holder],
  });
}

afterAll(async () => {
  await f?.stop();
  await upstream?.stop();
});

describe("fork()", () => {
  test("serves the forked chain on a local port", async () => {
    expect(f.rpcUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await f.client.getChainId()).toBe(foundry.id);
  });

  test("warns when the fork is not pinned to a block", () => {
    expect(warnings.some((w) => w.includes("not reproducible"))).toBe(true);
  });

  test("refuses an upstream that serves a different chain", async () => {
    await expect(fork({ chain: mainnet, forkUrl: upstream.url, blockNumber: 0n })).rejects.toThrow(
      /serves chain 31337/,
    );
  });

  test("a bad option throws before anything boots, so no anvil is left running", async () => {
    // The upstream is unreachable: had anvil been started first, this would be a ForkBootError
    // after the boot timeout, not the option error at once.
    const started = Date.now();
    await expect(
      fork({
        chain: foundry,
        forkUrl: "http://127.0.0.1:9",
        blockNumber: 1n,
        traces: "sometimes" as "off",
      }),
    ).rejects.toThrow(/traces must be "on-failure" or "off"/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a bad gas snapshot mode also throws before anything boots", async () => {
    const started = Date.now();
    await expect(
      fork({
        chain: foundry,
        forkUrl: "http://127.0.0.1:9",
        blockNumber: 1n,
        gasSnapshot: "sometimes" as "off",
      }),
    ).rejects.toThrow(/gasSnapshot "sometimes" is not one of/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("fails loudly when the upstream is unreachable", async () => {
    await expect(
      fork({
        chain: foundry,
        forkUrl: "http://127.0.0.1:9",
        blockNumber: 1n,
        bootTimeoutMs: 20_000,
      }),
    ).rejects.toBeInstanceOf(ForkBootError);
  });

  test("on() returns the same handle for its own chain and refuses others", () => {
    expect(f.on(foundry)).toBe(f);
    expect(() => f.on(mainnet)).toThrow(ForkitError);
  });
});

describe("cheats", () => {
  test("dealNative sets the native balance", async () => {
    await f.dealNative(alice, parseEther("3"));
    expect(await f.client.getBalance({ address: alice })).toBe(parseEther("3"));
  });

  test("deal via anvil_dealERC20 sets an exact ERC-20 balance", async () => {
    await f.deal(plainToken, alice, 1_234n, { via: "anvil_dealERC20" });
    expect(await balanceOf(plainToken, alice)).toBe(1_234n);
  });

  test("deal via storage-slot discovery finds the mapping and sets the balance", async () => {
    await f.deal(plainToken, bob, 5_678n, { via: "storage" });
    expect(await balanceOf(plainToken, bob)).toBe(5_678n);
    await f.deal(plainToken, bob, 42n);
    expect(await balanceOf(plainToken, bob)).toBe(42n);
  });

  test("deal refuses tokens with derived balances", async () => {
    await expect(f.deal(sharesToken, alice, 100n, { via: "storage" })).rejects.toBeInstanceOf(
      DealError,
    );
    await expect(f.deal(sharesToken, alice, 100n)).rejects.toBeInstanceOf(DealError);
  });

  test("prank sends as an address without its key, then stops impersonating", async () => {
    await f.dealNative(alice, parseEther("5"));
    const before = await f.client.getBalance({ address: bob });
    await f.prank(alice, async (c) => {
      const hash = await c.sendTransaction({ to: bob, value: parseEther("1") });
      await c.waitForTransactionReceipt({ hash });
    });
    expect(await f.client.getBalance({ address: bob })).toBe(before + parseEther("1"));
    await expect(
      f.client.sendTransaction({ account: alice, to: bob, value: 1n }),
    ).rejects.toThrow();
  });

  test("warp advances block time; roll mines blocks", async () => {
    const start = await f.client.getBlock();
    await f.warp(3_600);
    const warped = await f.client.getBlock();
    expect(warped.timestamp - start.timestamp).toBeGreaterThanOrEqual(3_600n);
    await f.roll(10n);
    expect(await f.client.getBlockNumber()).toBe(warped.number + 10n);
  });

  test("snapshot and revertTo restore state; a consumed snapshot is refused", async () => {
    await f.dealNative(alice, 1n);
    const id = await f.snapshot();
    await f.dealNative(alice, 2n);
    await f.revertTo(id);
    expect(await f.client.getBalance({ address: alice })).toBe(1n);
    await expect(f.revertTo(id)).rejects.toThrow(/take a new snapshot/);
  });

  test("warp and roll reject negative counts", async () => {
    await expect(f.warp(-1)).rejects.toThrow(ForkitError);
    await expect(f.roll(1.5)).rejects.toThrow(ForkitError);
  });
});

describe("stop()", () => {
  test("is idempotent and frees the port", async () => {
    const g = await fork({ chain: foundry, forkUrl: upstream.url, blockNumber: 0n });
    const url = g.rpcUrl;
    await g.stop();
    await g.stop();
    await expect(fetch(url, { method: "POST" })).rejects.toThrow();
  });
});
