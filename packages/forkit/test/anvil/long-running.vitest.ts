import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, defineChain, encodeFunctionData, parseEther } from "viem";
import { foundry, mainnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  attachFork,
  erc20BalanceAbi,
  ForkBootError,
  fork,
  freePort,
  startRpcCache,
} from "../../src/index.ts";
import { PLAIN_TOKEN_RUNTIME } from "../fixtures/tokens.ts";
import { startUpstream } from "./upstream.ts";

// What a long-running local stack needs from forkit: fixed ports, its own anvil flags, chains
// with nothing to fork, handles on anvils it started itself, and the fork cache on its own.

const alice: Address = "0x00000000000000000000000000000000000a11ce";
const bob: Address = "0x0000000000000000000000000000000000000b0b";
// anvil's first dev account, funded on every anvil at block 0.
const DEV: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const token: Address = "0x00000000000000000000000000000000000070a1";

const noRpcChain = defineChain({
  id: 4_663,
  name: "NoRpc",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

let upstream: Awaited<ReturnType<typeof startUpstream>>;
beforeAll(async () => {
  upstream = await startUpstream();
});
afterAll(async () => {
  await upstream?.stop();
});

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await response.json()) as { result?: unknown }).result;
}

describe("fork() options for a long-running stack", () => {
  test("port: the fork's anvil listens on the port asked for", async () => {
    const port = await freePort();
    const f = await fork({ chain: foundry, forkUrl: upstream.url, blockNumber: 0n, port });
    try {
      expect(f.rpcUrl).toBe(`http://127.0.0.1:${port}`);
      expect(await f.client.getChainId()).toBe(foundry.id);
    } finally {
      await f.stop();
    }
  });

  test("anvil: extra flags reach anvil (gas limit, step traces)", async () => {
    const f = await fork({
      chain: foundry,
      forkUrl: upstream.url,
      blockNumber: 0n,
      anvil: { gasLimit: 123_456_789n, stepsTracing: true },
    });
    try {
      await f.client.setCode({ address: token, bytecode: PLAIN_TOKEN_RUNTIME });
      await f.dealNative(alice, parseEther("1"));
      const data = encodeFunctionData({
        abi: erc20BalanceAbi,
        functionName: "balanceOf",
        args: [bob],
      });
      const hash = await f.prank(alice, (c) => c.sendTransaction({ to: token, data }));
      expect((await f.client.getBlock()).gasLimit).toBe(123_456_789n);
      // anvil returns no struct logs unless it keeps steps.
      const trace = (await rpc(f.rpcUrl, "debug_traceTransaction", [hash])) as {
        structLogs: unknown[];
      };
      expect(trace.structLogs.length).toBeGreaterThan(0);
    } finally {
      await f.stop();
    }
  });

  test("forkUrl: false starts an empty chain with the chain's id, with no warning", async () => {
    const warnings: string[] = [];
    const f = await fork({ chain: noRpcChain, forkUrl: false, onWarn: (m) => warnings.push(m) });
    try {
      expect(await f.client.getChainId()).toBe(noRpcChain.id);
      expect(await f.client.getBlockNumber()).toBe(0n);
      expect(f.cacheStats()).toBeUndefined();
      expect(warnings).toEqual([]);
      await f.dealNative(alice, 7n);
      expect(await f.client.getBalance({ address: alice })).toBe(7n);
    } finally {
      await f.stop();
    }
  });

  test("forkUrl: false with a pinned block is a bad option", async () => {
    await expect(fork({ chain: noRpcChain, forkUrl: false, blockNumber: 1n })).rejects.toThrow(
      /no block 1 to pin/,
    );
  });
});

describe("attachFork()", () => {
  test("gives cheats on an anvil forkit did not start, and stop() leaves it running", async () => {
    const f = await attachFork(foundry, upstream.url);
    expect(f.rpcUrl).toBe(upstream.url);
    await f.client.setCode({ address: token, bytecode: PLAIN_TOKEN_RUNTIME });
    await f.deal(token, alice, 1_234n);
    const balance = await f.client.readContract({
      address: token,
      abi: erc20BalanceAbi,
      functionName: "balanceOf",
      args: [alice],
    });
    expect(balance).toBe(1_234n);
    await f.stop();
    expect(await rpc(upstream.url, "eth_chainId")).toBe("0x7a69");
  });

  test("refuses an anvil that serves another chain, or none", async () => {
    await expect(attachFork(mainnet, upstream.url)).rejects.toThrow(/serves chain 31337/);
    await expect(attachFork(foundry, "http://127.0.0.1:9")).rejects.toBeInstanceOf(ForkBootError);
  });
});

describe("startRpcCache() on its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "forkit-own-cache-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const read = [DEV, "0x0"];

  test("records behind any launcher, flush() writes while it still serves, then replays", async () => {
    const options = { upstream: upstream.url, chainId: foundry.id, blockNumber: 0n, dir };
    const cold = await startRpcCache({ ...options, mode: "readwrite" });
    expect(cold.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const balance = await rpc(cold.url, "eth_getBalance", read);
    expect(cold.stats().misses).toBe(1);
    expect(existsSync(cold.stats().path)).toBe(false);
    cold.flush();
    expect(existsSync(cold.stats().path)).toBe(true);
    expect(await rpc(cold.url, "eth_getBalance", read)).toBe(balance);
    await cold.close();

    const warm = await startRpcCache({
      ...options,
      upstream: "http://127.0.0.1:9",
      mode: "offline",
    });
    expect(await rpc(warm.url, "eth_getBalance", read)).toBe(balance);
    expect(warm.stats()).toMatchObject({ hits: 1, misses: 0 });
    await warm.close();
  });

  test("takes the port it is given", async () => {
    const port = await freePort();
    const cache = await startRpcCache({
      upstream: upstream.url,
      chainId: foundry.id,
      blockNumber: 0n,
      dir,
      mode: "readonly",
      port,
    });
    expect(cache.url).toBe(`http://127.0.0.1:${port}`);
    await cache.close();
  });
});
