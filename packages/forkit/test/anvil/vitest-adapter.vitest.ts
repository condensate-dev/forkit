import { type Address, parseEther } from "viem";
import { foundry } from "viem/chains";
import { afterAll, describe, expect } from "vitest";
import { describeFork, itFork } from "../../src/vitest.ts";
import { startUpstream } from "./upstream.ts";

const alice: Address = "0x00000000000000000000000000000000000a11ce";

// The upstream must be up before describeFork's beforeAll boots the fork, so start it at module
// load and hand describeFork a URL we know now.
const upstream = await startUpstream();
afterAll(() => upstream.stop());

describeFork("describeFork", { chain: foundry, forkUrl: upstream.url, blockNumber: 0n }, (f) => {
  itFork("the first test changes state", async () => {
    await f.dealNative(alice, parseEther("7"));
    expect(await f.client.getBalance({ address: alice })).toBe(parseEther("7"));
  });

  itFork("the next test starts from a clean snapshot", async (g) => {
    expect(await g.client.getBalance({ address: alice })).toBe(0n);
  });

  itFork("the handle is the same object in both styles", async (g) => {
    expect(g.rpcUrl).toBe(f.rpcUrl);
  });

  describe("a nested describe", () => {
    itFork("reaches the enclosing fork", async (g) => {
      expect(g.rpcUrl).toBe(f.rpcUrl);
      await g.dealNative(alice, parseEther("3"));
    });

    describe("two levels down", () => {
      itFork("still isolated by the enclosing fork", async (g) => {
        expect(await g.client.getBalance({ address: alice })).toBe(0n);
      });
    });
  });
});

describeFork(
  "a second describeFork",
  { chain: foundry, forkUrl: upstream.url, blockNumber: 0n },
  (f) => {
    describe("nested", () => {
      itFork("gets its own fork, not the first one's", async (g) => {
        expect(g).toBe(f);
      });
    });
  },
);
