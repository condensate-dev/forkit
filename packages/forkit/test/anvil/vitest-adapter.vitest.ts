import { type Address, parseEther } from "viem";
import { foundry } from "viem/chains";
import { afterAll, describe, expect } from "vitest";
import { onForkitEvent, type TestEndEvent, type TestStartEvent } from "../../src/index.ts";
import * as vitestAdapter from "../../src/vitest.ts";
import { describeFork, itFork } from "../../src/vitest.ts";
import { adapterContract, startUpstreams } from "./adapter-contract.ts";

const alice: Address = "0x00000000000000000000000000000000000a11ce";

// The upstreams must be up before describeFork's beforeAll boots the fork, so start them at
// module load and hand describeFork URLs we know now.
const upstreams = await startUpstreams();
afterAll(() => upstreams.stop());
const testEvents: (TestStartEvent | TestEndEvent)[] = [];
onForkitEvent((e) => {
  if (e.type === "test:start" || e.type === "test:end") testEvents.push(e);
});

describeFork(
  "describeFork",
  { chain: foundry, forkUrl: upstreams.a.url, blockNumber: 0n, cache: "off" },
  (f) => {
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

    itFork("emits test:start before and test:end after each itFork", async () => {
      const mine = testEvents.filter(
        (e) => e.name === "emits test:start before and test:end after each itFork",
      );
      expect(mine.map((e) => e.type)).toEqual(["test:start"]);
      const earlier = testEvents.find(
        (e) => e.type === "test:end" && e.name === "the first test changes state",
      );
      expect(earlier).toMatchObject({ suite: "describeFork", status: "pass" });
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
  },
);

describeFork(
  "a second describeFork",
  { chain: foundry, forkUrl: upstreams.a.url, blockNumber: 0n, cache: "off" },
  (f) => {
    describe("nested", () => {
      itFork("gets its own fork, not the first one's", async (g) => {
        expect(g).toBe(f);
      });
    });
  },
);

adapterContract("vitest", vitestAdapter, upstreams, describe, {
  equal: (actual, expected) => expect(actual).toEqual(expected),
});
