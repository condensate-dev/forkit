import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { foundry } from "viem/chains";
import { afterAll, expect, test } from "vitest";
import { fork } from "../../src/index.ts";
import { startUpstream } from "./upstream.ts";

// anvil's first dev account, funded on the upstream at block 0.
const DEV: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const cacheDir = mkdtempSync(join(tmpdir(), "forkit-cache-"));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

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

test("offline mode fails loudly on a miss instead of reaching the network", async () => {
  await expect(
    fork({
      chain: foundry,
      forkUrl: "http://127.0.0.1:9",
      blockNumber: 7n,
      cacheDir,
      cache: "offline",
      bootTimeoutMs: 20_000,
    }),
  ).rejects.toThrow();
});

test("unpinned forks bypass the cache", async () => {
  const upstream = await startUpstream();
  const live = await fork({ chain: foundry, forkUrl: upstream.url, cacheDir, onWarn: () => {} });
  expect(live.cacheStats()).toBeUndefined();
  await live.stop();
  await upstream.stop();
});
