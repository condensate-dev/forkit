import { type Address, parseEther } from "viem";
import { foundry } from "viem/chains";
import { expect } from "vitest";
import { describeFork, itFork } from "../../src/vitest.ts";

/**
 * Both files run this with a different amount, in parallel workers. Each must see a clean fork
 * and keep it to itself for as long as it holds the lease.
 */
export function sharedContract(file: string, amount: string): void {
  const holder: Address = "0x00000000000000000000000000000000000a11ce";
  describeFork(
    `shared fork (${file})`,
    foundry,
    (f) => {
      itFork("attaches to the global setup's anvil instead of booting one", () => {
        expect(f.rpcUrl).toBe(process.env.FORKIT_TEST_SHARED_URL);
      });

      itFork("finds the fork as every file left it: clean", async () => {
        expect(await f.client.getBalance({ address: holder })).toBe(0n);
        expect(await f.client.getBlockNumber()).toBe(0n);
      });

      itFork("has the fork to itself while it holds the lease", async () => {
        await f.dealNative(holder, parseEther(amount));
        await f.roll(3);
        await new Promise((ok) => setTimeout(ok, 300));
        expect(await f.client.getBalance({ address: holder })).toBe(parseEther(amount));
        expect(await f.client.getBlockNumber()).toBe(3n);
      });

      itFork("still isolates each test", async () => {
        expect(await f.client.getBalance({ address: holder })).toBe(0n);
      });
    },
    { shared: true },
  );
}
