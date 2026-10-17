/**
 * surfnet() against a real surfpool (the pinned release; scripts/with-surfpool.sh). The fork
 * source is a second, offline surfpool on this machine, so nothing here needs the network.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { address, lamports } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { redactUrl } from "../../src/rpc.ts";
import {
  SURFPOOL_VERSION,
  type Surfnet,
  SurfnetBootError,
  SurfnetRpcError,
  surfnet,
} from "../../src/svm/index.ts";
import { eventually, SEEDED, SEEDED_LAMPORTS, startUpstream } from "./upstream.ts";

let upstream: Surfnet;
beforeAll(async () => {
  upstream = await startUpstream();
});
afterAll(() => upstream?.stop());

describe("surfnet()", () => {
  test("boots offline, healthy and ready, on loopback ports", async () => {
    const s = await surfnet({ offline: true });
    try {
      expect(s.source).toBe("offline");
      expect(s.surfpoolVersion).toBe(SURFPOOL_VERSION);
      expect(s.rpcUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(s.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      expect(await s.rpc.getHealth().send()).toBe("ok");
      expect((await s.info()).startup.phase).toBe("ready");
    } finally {
      await s.stop();
    }
  });

  test("forks an RPC: accounts load on demand, and writes stay on the fork", async () => {
    const s = await surfnet({ rpcUrl: upstream.rpcUrl });
    try {
      expect(s.source).toBe(redactUrl(upstream.rpcUrl));
      // Only the upstream has this wallet: the fork fetched it the first time it was read.
      expect((await s.rpc.getBalance(SEEDED).send()).value).toBe(SEEDED_LAMPORTS);

      const fresh = address("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
      await s.rpc.requestAirdrop(fresh, lamports(1_000_000n)).send();
      await eventually(async () => (await s.rpc.getBalance(fresh).send()).value === 1_000_000n);
      expect((await upstream.rpc.getBalance(fresh).send()).value).toBe(0n);
    } finally {
      await s.stop();
    }
  });

  test("surfnets in parallel get their own ports", async () => {
    const all = await Promise.all([1, 2, 3].map(() => surfnet({ rpcUrl: upstream.rpcUrl })));
    try {
      const ports = all.flatMap((s) => [s.rpcUrl, s.wsUrl]);
      expect(new Set(ports).size).toBe(ports.length);
      for (const s of all) expect(await s.rpc.getHealth().send()).toBe("ok");
    } finally {
      await Promise.all(all.map((s) => s.stop()));
    }
  });

  test("stop() is idempotent, and the surfnet is gone after it", async () => {
    const s = await surfnet({ offline: true });
    await Promise.all([s.stop(), s.stop()]);
    await s.stop();
    await expect(s.request("getHealth")).rejects.toBeInstanceOf(SurfnetRpcError);
  });

  test("stop() right after boot exits promptly, not at the kill ceiling", async () => {
    // surfpool 1.6 can swallow a SIGTERM sent just after it reports ready; stop() resends it.
    for (let i = 0; i < 3; i++) {
      const s = await surfnet({ offline: true, stopTimeoutMs: 8_000 });
      const started = Date.now();
      await s.stop();
      expect(Date.now() - started).toBeLessThan(4_000);
    }
  });

  test("leaves nothing in the working directory", async () => {
    const s = await surfnet({ offline: true });
    await s.stop();
    expect(existsSync(join(process.cwd(), ".surfpool"))).toBe(false);
  });

  test("an unreachable fork source fails the boot, says why, and masks the URL", async () => {
    // A closed port, and a long path segment that redactUrl treats as an API key.
    const secret = "k3y-0123456789abcdefghijklmnop";
    const error = await surfnet({
      rpcUrl: `http://127.0.0.1:9/${secret}`,
      bootTimeoutMs: 20_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SurfnetBootError);
    const message = (error as Error).message;
    expect(message).toContain("fork source: http://127.0.0.1:9/<redacted>");
    expect(message).toContain("surfpool output:");
    expect(message).not.toContain(secret);
  });

  test("a JSON-RPC error answer is a SurfnetRpcError with its code", async () => {
    const error = await upstream.request("surfnet_noSuchMethod").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SurfnetRpcError);
    expect((error as SurfnetRpcError).code).toBe(-32601);
  });
});
