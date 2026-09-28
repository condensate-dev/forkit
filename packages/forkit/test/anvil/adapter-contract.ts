/**
 * The same adapter test for every runner: a multi-chain describeFork whose tests change state on
 * both chains, then check that the next test starts clean on both.
 */
import { type Address, parseEther } from "viem";
import { foundry } from "viem/chains";
import type { ForkAdapter } from "../../src/index.ts";
import { otherChain, startUpstream } from "./upstream.ts";

export const alice: Address = "0x00000000000000000000000000000000000a11ce";

export interface Expect {
  equal(actual: unknown, expected: unknown): void;
}

export async function startUpstreams() {
  const [a, b] = await Promise.all([startUpstream(), startUpstream(otherChain.id)]);
  return { a, b, stop: () => Promise.all([a.stop(), b.stop()]).then(() => {}) };
}

export function adapterContract(
  runner: string,
  { describeFork, itFork }: ForkAdapter,
  upstreams: Awaited<ReturnType<typeof startUpstreams>>,
  /** The runner's own `describe`, to check itFork inside a nested block. */
  describe: (name: string, body: () => void) => void,
  expect: Expect,
): void {
  describeFork(
    `describeFork (${runner})`,
    [
      { chain: foundry, forkUrl: upstreams.a.url, blockNumber: 0n, cache: "off" },
      { chain: otherChain, forkUrl: upstreams.b.url, blockNumber: 0n, cache: "off" },
    ],
    (f) => {
      const other = f.on(otherChain);

      itFork("the first test changes state on both chains", async () => {
        await f.dealNative(alice, parseEther("7"));
        await other.dealNative(alice, parseEther("3"));
        expect.equal(await f.client.getBalance({ address: alice }), parseEther("7"));
        expect.equal(await other.client.getBalance({ address: alice }), parseEther("3"));
      });

      itFork("the next test starts from a clean snapshot on both chains", async (g) => {
        expect.equal(await g.client.getBalance({ address: alice }), 0n);
        expect.equal(await g.on(otherChain).client.getBalance({ address: alice }), 0n);
      });

      itFork("selects the first chain and reaches the other with on()", async (g) => {
        expect.equal(g.rpcUrl, f.rpcUrl);
        expect.equal(await g.client.getChainId(), foundry.id);
        expect.equal(await other.client.getChainId(), otherChain.id);
        expect.equal(g.forks.length, 2);
      });

      describe("a nested describe", () => {
        itFork("reaches the enclosing multi-chain fork", async (g) => {
          expect.equal(g.rpcUrl, f.rpcUrl);
          expect.equal(await g.on(otherChain).client.getChainId(), otherChain.id);
        });
      });
    },
  );
}
