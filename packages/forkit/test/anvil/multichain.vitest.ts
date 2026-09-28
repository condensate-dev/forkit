import { createServer } from "node:net";
import { parseEther } from "viem";
import { foundry, mainnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Fork, ForkitError, fork } from "../../src/index.ts";
import { alice, startUpstreams } from "./adapter-contract.ts";
import { otherChain } from "./upstream.ts";

let upstreams: Awaited<ReturnType<typeof startUpstreams>>;
let f: Fork<typeof foundry>;

beforeAll(async () => {
  upstreams = await startUpstreams();
  f = await fork([
    { chain: foundry, forkUrl: upstreams.a.url, blockNumber: 0n, cache: "off" },
    { chain: otherChain, forkUrl: upstreams.b.url, blockNumber: 0n, cache: "off" },
  ]);
});

afterAll(async () => {
  await f?.stop();
  await upstreams?.stop();
});

/** Whether something is listening on the port of `url`. */
function listening(url: string): Promise<boolean> {
  const port = Number(new URL(url).port);
  return new Promise((ok) => {
    const probe = createServer();
    probe.once("error", () => ok(true));
    probe.listen(port, "127.0.0.1", () => probe.close(() => ok(false)));
  });
}

describe("fork([...])", () => {
  test("boots one anvil per chain and selects the first", async () => {
    const other = f.on(otherChain);
    expect(f.chain.id).toBe(foundry.id);
    expect(other.rpcUrl).not.toBe(f.rpcUrl);
    expect(await f.client.getChainId()).toBe(foundry.id);
    expect(await other.client.getChainId()).toBe(otherChain.id);
    expect(f.forks.map((g) => g.chain.id)).toEqual([foundry.id, otherChain.id]);
  });

  test("on() is symmetric and stable", () => {
    const other = f.on(otherChain);
    expect(other.on(foundry)).toBe(f);
    expect(f.on(foundry)).toBe(f);
    expect(f.on(otherChain)).toBe(other);
  });

  test("on() refuses a chain the handle does not fork, naming the ones it does", () => {
    expect(() => f.on(mainnet)).toThrow(/forks Foundry \(31337\), Other \(31338\), not Ethereum/);
  });

  test("chains have independent state and snapshots", async () => {
    const other = f.on(otherChain);
    const id = await other.snapshot();
    await f.dealNative(alice, parseEther("1"));
    await other.dealNative(alice, parseEther("2"));
    expect(await f.client.getBalance({ address: alice })).toBe(parseEther("1"));
    await other.revertTo(id);
    expect(await other.client.getBalance({ address: alice })).toBe(0n);
    expect(await f.client.getBalance({ address: alice })).toBe(parseEther("1"));
  });
});

test("stop() on any chain's handle stops every chain", async () => {
  const g = await fork([
    { chain: foundry, forkUrl: upstreams.a.url, blockNumber: 0n, cache: "off" },
    { chain: otherChain, forkUrl: upstreams.b.url, blockNumber: 0n, cache: "off" },
  ]);
  const urls = g.forks.map((h) => h.rpcUrl);
  await g.on(otherChain).stop();
  expect(await Promise.all(urls.map(listening))).toEqual([false, false]);
  await g.stop();
});

test("a chain that fails to boot stops the chains that did", async () => {
  const warnings: string[] = [];
  const failing = fork([
    { chain: foundry, forkUrl: upstreams.a.url, cache: "off", onWarn: (w) => warnings.push(w) },
    { chain: otherChain, forkUrl: "http://127.0.0.1:9", blockNumber: 1n, bootTimeoutMs: 20_000 },
  ]);
  await expect(failing).rejects.toThrow(/failed to fork Other/);
  expect(warnings.some((w) => w.includes("not reproducible"))).toBe(true);
});

test("the same chain twice is refused before anything boots", async () => {
  await expect(fork([foundry, { chain: foundry }])).rejects.toBeInstanceOf(ForkitError);
});
