import { base, mainnet, optimism } from "viem/chains";
import { describe, expect, test } from "vitest";
import { anvilParameters } from "../../src/fork.ts";
import {
  AnvilNotFoundError,
  assertAnvilInstalled,
  ForkitError,
  fork,
  freePort,
  isOpStack,
  resolveForkUrl,
} from "../../src/index.ts";
import { redactUrl } from "../../src/rpc.ts";

describe("resolveForkUrl", () => {
  test("explicit forkUrl wins", () => {
    expect(resolveForkUrl(base, "http://explicit", { FORKIT_RPC_URL_8453: "http://env" })).toEqual({
      url: "http://explicit",
      source: "option",
    });
  });

  test("then the per-chain env override", () => {
    expect(resolveForkUrl(base, undefined, { FORKIT_RPC_URL_8453: "http://env" })).toEqual({
      url: "http://env",
      source: "env",
    });
  });

  test("an override for another chain does not apply", () => {
    expect(resolveForkUrl(base, undefined, { FORKIT_RPC_URL_1: "http://env" })).toEqual({
      url: base.rpcUrls.default.http[0],
      source: "chain-default",
    });
  });
});

describe("OP-stack detection and anvil flags", () => {
  test("detects OP-stack from the viem chain", () => {
    expect(isOpStack(base)).toBe(true);
    expect(isOpStack(optimism)).toBe(true);
    expect(isOpStack(mainnet)).toBe(false);
  });

  test("passes optimism: true for OP-stack chains", () => {
    expect(anvilParameters({ chain: base, blockNumber: 1n }, "http://rpc", 1).optimism).toBe(true);
  });

  test("never passes optimism: false (anvil would parse it as a subcommand)", () => {
    const params = anvilParameters({ chain: mainnet }, "http://rpc", 1);
    expect("optimism" in params).toBe(false);
    expect(Object.values(params)).not.toContain(false);
  });

  test("pins the block; behind forkit's cache, anvil's own cache and rate limit are off", () => {
    const params = anvilParameters({ chain: mainnet, blockNumber: 123n }, "http://rpc", 4242, true);
    expect(params).toMatchObject({
      forkUrl: "http://rpc",
      forkBlockNumber: 123n,
      port: 4242,
      host: "127.0.0.1",
      noStorageCaching: true,
      noRateLimit: true,
    });
    expect("noStorageCaching" in anvilParameters({ chain: mainnet }, "http://rpc", 1)).toBe(false);
  });
});

describe("ports", () => {
  test("come from the OS and do not collide", async () => {
    const ports = await Promise.all(Array.from({ length: 8 }, () => freePort()));
    for (const port of ports) expect(port).toBeGreaterThan(0);
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe("missing anvil", () => {
  test("throws an install hint instead of skipping", () => {
    expect(() => assertAnvilInstalled("forkit-no-such-anvil-binary")).toThrow(AnvilNotFoundError);
    expect(() => assertAnvilInstalled("forkit-no-such-anvil-binary")).toThrow(/foundryup/);
  });
});

describe("redactUrl", () => {
  test("hides API keys in paths and queries", () => {
    expect(redactUrl("https://base-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz123")).toBe(
      "https://base-mainnet.g.alchemy.com/v2/<redacted>",
    );
    expect(redactUrl("https://rpc.example/?apikey=secret")).toBe("https://rpc.example/?<redacted>");
    expect(redactUrl("https://user:pass@rpc.example/")).toBe("https://rpc.example/");
  });
});

describe("fork([...]) arguments", () => {
  test("refuses an empty list", async () => {
    await expect(fork([] as unknown as Parameters<typeof fork>[0])).rejects.toThrow(/at least one/);
  });

  test("refuses the same chain twice before booting anything", async () => {
    await expect(fork([base, { chain: base, blockNumber: 1n }])).rejects.toThrow(ForkitError);
    await expect(fork([base, { chain: base }])).rejects.toThrow(/lists chain 8453 twice/);
  });
});
