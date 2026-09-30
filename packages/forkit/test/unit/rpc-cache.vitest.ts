import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { freePort } from "../../src/anvil.ts";
import { ForkCacheMissError, ForkitError } from "../../src/errors.ts";
import {
  blockHeaderHash,
  type CacheMode,
  cacheFilePath,
  cacheKey,
  deriveAccountRead,
  isCacheable,
  resolveCacheSettings,
  startRpcCache,
  unknownBlockHash,
} from "../../src/rpc-cache.ts";

const PINNED = 100n;

describe("isCacheable", () => {
  test("state reads at or before the pinned block are cacheable", () => {
    expect(
      isCacheable({ method: "eth_getStorageAt", params: ["0xabc", "0x0", "0x64"] }, PINNED),
    ).toBe(true);
    expect(isCacheable({ method: "eth_getBalance", params: ["0xabc", "0x10"] }, PINNED)).toBe(true);
    expect(isCacheable({ method: "eth_getBlockByNumber", params: ["0x64", true] }, PINNED)).toBe(
      true,
    );
  });

  test("reads after the pinned block or at a tag are not", () => {
    expect(isCacheable({ method: "eth_getBalance", params: ["0xabc", "0x65"] }, PINNED)).toBe(
      false,
    );
    expect(isCacheable({ method: "eth_getBalance", params: ["0xabc", "latest"] }, PINNED)).toBe(
      false,
    );
    expect(isCacheable({ method: "eth_blockNumber", params: [] }, PINNED)).toBe(false);
    expect(isCacheable({ method: "eth_sendRawTransaction", params: ["0x00"] }, PINNED)).toBe(false);
  });

  test("immutable lookups and boot-time fee reads are cacheable", () => {
    expect(isCacheable({ method: "eth_chainId" }, PINNED)).toBe(true);
    expect(isCacheable({ method: "eth_getBlockByHash", params: ["0xhash", false] }, PINNED)).toBe(
      true,
    );
    expect(isCacheable({ method: "eth_gasPrice", params: [] }, PINNED)).toBe(true);
  });
});

describe("cacheKey", () => {
  test("ignores address case and request ids", () => {
    expect(cacheKey({ id: 1, method: "eth_getCode", params: ["0xAbC", "0x1"] })).toBe(
      cacheKey({ id: 2, method: "eth_getCode", params: ["0xabc", "0x1"] }),
    );
  });
});

describe("reads pinned by block hash (anvil >= 1.8)", () => {
  const HASH = `0x${"ab".repeat(32)}`;
  const LATER = `0x${"cd".repeat(32)}`;
  const hashes = new Map([
    [HASH, 0x64n],
    [LATER, 0x65n],
  ]);

  test("a known hash at or before the pinned block is cacheable; unknown or later is not", () => {
    const at = (block: unknown) => ({ method: "eth_getBalance", params: ["0xabc", block] });
    expect(isCacheable(at(HASH), PINNED, hashes)).toBe(true);
    expect(isCacheable(at(HASH.toUpperCase().replace("0X", "0x")), PINNED, hashes)).toBe(true);
    expect(isCacheable(at({ blockHash: HASH }), PINNED, hashes)).toBe(true);
    expect(isCacheable(at(LATER), PINNED, hashes)).toBe(false);
    expect(isCacheable(at(HASH), PINNED)).toBe(false);
  });

  test("keys by block number, so number- and hash-pinned recordings are interchangeable", () => {
    const byNumber = cacheKey({ method: "eth_getStorageAt", params: ["0xabc", "0x0", "0x64"] });
    expect(cacheKey({ method: "eth_getStorageAt", params: ["0xabc", "0x0", HASH] }, hashes)).toBe(
      byNumber,
    );
    expect(cacheKey({ method: "eth_getBlockByNumber", params: ["0x64", false] }, hashes)).toBe(
      'eth_getBlockByNumber:["0x64",false]',
    );
  });

  test("flags a hash it cannot key yet, so the proxy fetches that header first", () => {
    const read = (block: unknown) => ({ method: "eth_getCode", params: ["0xabc", block] });
    expect(unknownBlockHash(read(`0x${"ef".repeat(32)}`), hashes)).toBe(`0x${"ef".repeat(32)}`);
    expect(unknownBlockHash(read({ blockHash: `0x${"ef".repeat(32)}` }), hashes)).toBeDefined();
    expect(unknownBlockHash(read(HASH), hashes)).toBeUndefined();
    expect(unknownBlockHash(read("0x64"), hashes)).toBeUndefined();
    expect(unknownBlockHash({ method: "eth_blockNumber", params: [] }, hashes)).toBeUndefined();
  });

  test("learns hash -> number from block headers", () => {
    expect(
      blockHeaderHash({ hash: HASH.toUpperCase().replace("0X", "0x"), number: "0x64" }),
    ).toEqual([HASH, 0x64n]);
    expect(blockHeaderHash({ hash: "0x12", number: "0x64" })).toBeUndefined();
    expect(blockHeaderHash(null)).toBeUndefined();
  });
});

describe("deriveAccountRead", () => {
  const params = ["0xabc", "0x0"];
  const info = { balance: "0x5", nonce: "0x1", code: "0x" };
  test("serves a balance, nonce or code from a recorded eth_getAccountInfo, and the reverse", () => {
    const fromInfo = (r: { method: string }) =>
      r.method === "eth_getAccountInfo" ? info : undefined;
    expect(deriveAccountRead({ method: "eth_getBalance", params }, fromInfo)).toBe("0x5");
    expect(deriveAccountRead({ method: "eth_getTransactionCount", params }, fromInfo)).toBe("0x1");
    expect(deriveAccountRead({ method: "eth_getCode", params }, fromInfo)).toBe("0x");
    const triple: Record<string, string> = {
      eth_getBalance: "0x5",
      eth_getTransactionCount: "0x1",
      eth_getCode: "0x",
    };
    expect(
      deriveAccountRead({ method: "eth_getAccountInfo", params }, (r) => triple[r.method]),
    ).toEqual(info);
  });

  test("needs the whole triple, and ignores other methods", () => {
    const partial: Record<string, string> = { eth_getBalance: "0x5", eth_getCode: "0x" };
    expect(
      deriveAccountRead({ method: "eth_getAccountInfo", params }, (r) => partial[r.method]),
    ).toBeUndefined();
    expect(deriveAccountRead({ method: "eth_getStorageAt", params }, () => info)).toBeUndefined();
    expect(
      deriveAccountRead({ method: "eth_getBalance", params }, () => undefined),
    ).toBeUndefined();
  });
});

describe("resolveCacheSettings", () => {
  test("defaults to readwrite in .forkit-cache", () => {
    expect(resolveCacheSettings(undefined, undefined, {})).toEqual({
      mode: "readwrite",
      dir: ".forkit-cache",
    });
  });

  test("env sets mode and dir; explicit options win", () => {
    const env = { FORKIT_CACHE: "offline", FORKIT_CACHE_DIR: "/c" };
    expect(resolveCacheSettings(undefined, undefined, env)).toEqual({ mode: "offline", dir: "/c" });
    expect(resolveCacheSettings("off", "/d", env)).toEqual({ mode: "off", dir: "/d" });
  });

  test("rejects an unknown env mode", () => {
    expect(() => resolveCacheSettings(undefined, undefined, { FORKIT_CACHE: "sometimes" })).toThrow(
      /not one of/,
    );
  });
});

describe("upstream errors", () => {
  test("a non-retryable, non-JSON answer (a 401 page) fails fast instead of retrying", async () => {
    let calls = 0;
    const upstream = createServer((_req, res) => {
      calls++;
      res.writeHead(401, { "content-type": "text/html" }).end("<html>Unauthorized</html>");
    });
    await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", () => ok()));
    const { port } = upstream.address() as { port: number };
    const dir = mkdtempSync(join(tmpdir(), "forkit-cache-401-"));
    const cache = await startRpcCache({
      upstream: `http://127.0.0.1:${port}`,
      chainId: 1,
      blockNumber: 100n,
      mode: "readwrite",
      dir,
      port: await freePort(),
    });
    try {
      const started = Date.now();
      const response = await fetch(cache.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      expect(body.error?.message).toMatch(/HTTP 401, not JSON-RPC: <html>Unauthorized/);
      expect(calls).toBe(1);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await cache.close();
      upstream.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A cache proxy recording to `dir`, over `upstream` (by default port 9, where nothing listens). */
async function proxy(
  mode: Exclude<CacheMode, "off">,
  dir: string,
  upstream = "http://127.0.0.1:9",
) {
  const cache = await startRpcCache({
    upstream,
    chainId: 1,
    blockNumber: 100n,
    mode,
    dir,
    port: await freePort(),
  });
  let id = 0;
  const ask = async (method: string, params: unknown[]) => {
    const response = await fetch(cache.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    return (await response.json()) as { result?: unknown; error?: { message: string } };
  };
  return { cache, ask };
}

describe("offline misses", () => {
  const address = "0x0000000000000000000000000000000000000001";

  test("a miss fails the request, naming the method, its params and the recording", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forkit-cache-offline-"));
    const { cache, ask } = await proxy("offline", dir);
    try {
      const answer = await ask("eth_getStorageAt", [address, "0x2", "0x64"]);
      expect(answer.result).toBeUndefined();
      expect(answer.error?.message).toContain(
        `offline and eth_getStorageAt ["${address}","0x2","0x64"] is not in the fork cache (${cacheFilePath(dir, 1, 100n)})`,
      );
    } finally {
      await cache.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("close() rejects with every request that missed, once each, however often it was asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forkit-cache-offline-"));
    const { cache, ask } = await proxy("offline", dir);
    await ask("eth_getBalance", [address, "0x64"]);
    await ask("eth_getBalance", [address, "0x64"]);
    await ask("eth_getCode", [address, "0x64"]);
    // A hash lookup offline answers null, as the upstream does for a hash it never saw: no miss.
    expect((await ask("eth_getTransactionReceipt", [`0x${"ab".repeat(32)}`])).result).toBeNull();
    const failure = await cache.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    rmSync(dir, { recursive: true, force: true });

    expect(failure).toBeInstanceOf(ForkCacheMissError);
    expect(failure).toBeInstanceOf(ForkitError);
    const path = cacheFilePath(dir, 1, 100n);
    expect((failure as ForkCacheMissError).misses).toEqual([
      { path, method: "eth_getBalance", params: [address, "0x64"], count: 2 },
      { path, method: "eth_getCode", params: [address, "0x64"], count: 1 },
    ]);
    const message = (failure as Error).message;
    expect(message).toMatch(/^forkit: 2 request\(s\) missed the offline fork cache/);
    expect(message).toContain("FORKIT_CACHE=readwrite");
    expect(message).toContain(`\n  ${path}\n`);
    expect(message).toContain(`    eth_getBalance ["${address}","0x64"] (×2)`);
    expect(message).toContain(`    eth_getCode ["${address}","0x64"]`);
    // close() is idempotent, and so is its verdict.
    await expect(cache.close()).rejects.toBe(failure);
  });

  test("a replay that finds everything closes cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forkit-cache-offline-"));
    const upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const { id } = JSON.parse(body) as { id: number };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x2a" }));
      });
    });
    await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", () => ok()));
    const { port } = upstream.address() as { port: number };
    try {
      const recording = await proxy("readwrite", dir, `http://127.0.0.1:${port}`);
      expect((await recording.ask("eth_getBalance", [address, "0x64"])).result).toBe("0x2a");
      await recording.cache.close();

      const replay = await proxy("offline", dir);
      expect((await replay.ask("eth_getBalance", [address, "0x64"])).result).toBe("0x2a");
      await replay.cache.close();
      expect(replay.cache.stats()).toMatchObject({ hits: 1, misses: 0 });
    } finally {
      upstream.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the error lists at most 20 requests, and says how many more there are", () => {
    const misses = Array.from({ length: 23 }, (_, i) => ({
      path: "/c/1/100.json",
      method: "eth_getStorageAt",
      params: [address, `0x${i.toString(16)}`, "0x64"],
      count: 1,
    }));
    const { message } = new ForkCacheMissError(misses);
    expect(message.match(/eth_getStorageAt/g)).toHaveLength(20);
    expect(message).toContain("… and 3 more (FORKIT_DEBUG=1 logs every miss)");
  });
});
