import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Chain, createPublicClient, createWalletClient, http } from "viem";
import { foundry } from "viem/chains";
import { afterAll, expect, test } from "vitest";
import {
  expectRevert,
  ForkBootError,
  ForkCacheMissError,
  ForkitAssertionError,
  fork,
} from "../../src/index.ts";
import { COIN_BYTECODE, coinAbi } from "../fixtures/coin.ts";
import { otherChain, startUpstream } from "./upstream.ts";

// anvil's first dev account, funded on the upstream at block 0.
const DEV: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const cacheDir = mkdtempSync(join(tmpdir(), "forkit-cache-"));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

/** What `promise` rejected with (and a test failure if it resolved). */
const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => expect.fail("expected a rejection"),
    (error: unknown) => error,
  );

/**
 * An upstream with a Coin deployed at block 1, and a recording of a fork of it that booted and
 * read DEV's balance, and nothing of the Coin.
 */
async function recordedUpstream(chain: Chain, dir: string) {
  const upstream = await startUpstream(chain.id);
  const transport = http(upstream.url);
  const hash = await createWalletClient({ chain, transport, account: DEV }).deployContract({
    abi: coinAbi,
    bytecode: COIN_BYTECODE,
    args: [1_000n],
  });
  const receipt = await createPublicClient({ chain, transport }).waitForTransactionReceipt({
    hash,
  });
  const coin = receipt.contractAddress as Address;
  const options = { chain, forkUrl: upstream.url, blockNumber: receipt.blockNumber, cacheDir: dir };
  const cold = await fork({ ...options, cache: "readwrite" });
  await cold.client.getBalance({ address: DEV });
  await cold.stop();
  return { upstream, coin, options };
}

test("records a pinned fork, then replays it offline with the upstream gone", async () => {
  const upstream = await startUpstream();
  const options = { chain: foundry, forkUrl: upstream.url, blockNumber: 0n, cacheDir } as const;

  const cold = await fork({ ...options, cache: "readwrite" });
  const balance = await cold.client.getBalance({ address: DEV });
  const coldStats = cold.cacheStats();
  await cold.stop();
  expect(coldStats?.misses).toBeGreaterThan(0);

  await upstream.stop();

  const warm = await fork({ ...options, cache: "offline" });
  expect(await warm.client.getBalance({ address: DEV })).toBe(balance);
  expect(warm.cacheStats()).toMatchObject({ misses: 0, mode: "offline" });
  await warm.stop();
});

test("an offline miss is never a revert, and stop() names every request that missed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forkit-cache-miss-"));
  const { upstream, coin, options } = await recordedUpstream(foundry, dir);
  const f = await fork({ ...options, cache: "offline" });
  try {
    // The Coin was never recorded. anvil answers -32603 "failed to get …", which viem reports
    // as a revert of the call: expectRevert must not take it for one.
    const read = await failureOf(
      expectRevert(
        f.client.readContract({
          address: coin,
          abi: coinAbi,
          functionName: "balanceOf",
          args: [DEV],
        }),
      ),
    );
    expect(read).toBeInstanceOf(ForkitAssertionError);
    expect((read as Error).message).toMatch(/failed another way: [\s\S]*is not in the fork cache/);
    const write = await failureOf(
      expectRevert(
        f.prank(DEV, (c) =>
          c.writeContract({
            address: coin,
            abi: coinAbi,
            functionName: "transfer",
            args: [DEV, 1n],
          }),
        ),
      ),
    );
    expect(write).toBeInstanceOf(ForkitAssertionError);
    expect((write as Error).message).toContain("failed another way");
  } finally {
    const stopped = await failureOf(f.stop());
    await upstream.stop();
    rmSync(dir, { recursive: true, force: true });
    expect(stopped).toBeInstanceOf(ForkCacheMissError);
    const { misses, message } = stopped as ForkCacheMissError;
    expect(misses.length).toBeGreaterThan(0);
    for (const miss of misses) {
      expect(miss.path).toBe(join(dir, String(foundry.id), `${options.blockNumber}.json`));
      expect(miss.method).toMatch(/^eth_/);
    }
    expect(message).toContain(misses[0]?.path);
    expect(message).toContain(`${misses[0]?.method} ${JSON.stringify(misses[0]?.params)}`);
  }
});

test("a multi-chain fork stops every chain, and reports the misses of all of them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forkit-cache-miss-"));
  const [a, b] = await Promise.all([
    recordedUpstream(foundry, dir),
    recordedUpstream(otherChain, dir),
  ]);
  const f = await fork([
    { ...a.options, cache: "offline" },
    { ...b.options, cache: "offline" },
  ]);
  const read = (chain: Chain, coin: Address) =>
    f
      .on(chain)
      .client.readContract({ address: coin, abi: coinAbi, functionName: "totalSupply" })
      .catch(() => {});
  await Promise.all([read(foundry, a.coin), read(otherChain, b.coin)]);
  const stopped = await failureOf(f.stop());
  await Promise.all([a.upstream.stop(), b.upstream.stop()]);
  rmSync(dir, { recursive: true, force: true });

  expect(stopped).toBeInstanceOf(ForkCacheMissError);
  const paths = new Set((stopped as ForkCacheMissError).misses.map((m) => m.path));
  expect([...paths].sort()).toEqual(
    [
      join(dir, String(foundry.id), `${a.options.blockNumber}.json`),
      join(dir, String(otherChain.id), `${b.options.blockNumber}.json`),
    ].sort(),
  );
});

test("offline mode fails a boot it has no recording for, naming what it missed", async () => {
  const failure = await failureOf(
    fork({
      chain: foundry,
      forkUrl: "http://127.0.0.1:9",
      blockNumber: 7n,
      cacheDir,
      cache: "offline",
      bootTimeoutMs: 20_000,
    }),
  );
  expect(failure).toBeInstanceOf(ForkBootError);
  expect((failure as Error).message).toMatch(
    /^forkit: anvil failed to fork[\s\S]*missed the offline fork cache[\s\S]*\n {4}eth_\w+ \[/,
  );
});

test("unpinned forks bypass the cache", async () => {
  const upstream = await startUpstream();
  const live = await fork({ chain: foundry, forkUrl: upstream.url, cacheDir, onWarn: () => {} });
  expect(live.cacheStats()).toBeUndefined();
  await live.stop();
  await upstream.stop();
});
