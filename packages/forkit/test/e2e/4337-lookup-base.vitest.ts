/**
 * Live e2e: the bundler's receipt lookup window on a Base fork. With `receiptLookupBlocks`, alto
 * searches only blocks mined on the fork, so a lookup never goes to the upstream RPC.
 *
 * Public sources only:
 * - alto's `--max-block-range` and its use in `eth_getUserOperationReceipt`: `alto --help` and
 *   https://github.com/pimlicolabs/alto (src/executor/bundleManager.ts, `getUserOpReceipt`).
 * - The Coinbase Smart Wallet account: viem's `toCoinbaseSmartAccount`.
 *
 * Every key is derived from a fixed string, and the recording (.forkit-cache/4337-lookup)
 * replays offline in CI. An offline replay fails on any request the recording does not have,
 * so it also proves that the lookups made no `eth_getLogs` request to the RPC.
 */
import { type Address, getAddress, keccak256, parseEther, slice, toHex } from "viem";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { afterAll, beforeAll, expect } from "vitest";
import { type Bundler, bundler } from "../../src/4337/index.ts";
import { NATIVE } from "../../src/index.ts";
import { describeFork, itFork } from "../../src/vitest.ts";

const BLOCK = 51_900_000n;
const LOOKUP = 10;

const keyOf = (name: string) => keccak256(toHex(`forkit e2e 4337 lookup ${name}`));
const recipient: Address = getAddress(slice(keyOf("recipient"), 12));

describeFork(
  "Base: a short receipt lookup window for a long-running fork",
  { chain: base, blockNumber: BLOCK, cacheDir: ".forkit-cache/4337-lookup" },
  (f) => {
    let b: Bundler;
    beforeAll(async () => {
      b = await bundler(f, { receiptLookupBlocks: LOOKUP });
    });
    afterAll(async () => {
      await b?.stop();
    });

    itFork("the fork is taller than the window, and its clock did not move", async () => {
      // One block more than the window, then whatever alto mined when it started.
      expect(await f.client.getBlockNumber()).toBeGreaterThanOrEqual(BLOCK + BigInt(LOOKUP) + 1n);
      const forked = await f.client.getBlock({ blockNumber: BLOCK });
      const padded = await f.client.getBlock({ blockNumber: BLOCK + BigInt(LOOKUP) + 1n });
      expect(padded.timestamp).toBe(forked.timestamp);
      expect(padded.transactions).toEqual([]);
    });

    itFork("a lookup for an operation alto does not know stays on the fork", async () => {
      const receipt = await b.client.request({
        method: "eth_getUserOperationReceipt",
        params: [keyOf("an operation no one sent")],
      });
      expect(receipt).toBeNull();
      // While recording, a search below the fork block would show here as a miss.
      expect(f.cacheStats()?.missesByMethod.eth_getLogs).toBeUndefined();
    });

    itFork("a user operation still lands, and its receipt is found", async () => {
      const account = await toCoinbaseSmartAccount({
        client: f.client,
        owners: [privateKeyToAccount(keyOf("owner"))],
        version: "1.1",
      });
      await f.dealNative(account.address, parseEther("1"));
      await f.expectBalanceChange(NATIVE, recipient, 4_321n, async () => {
        const hash = await b.client.sendUserOperation({
          nonce: await account.getNonce({ key: 0n }),
          account,
          calls: [{ to: recipient, value: 4_321n }],
        });
        const receipt = await b.client.waitForUserOperationReceipt({ hash });
        expect(receipt.success).toBe(true);
      });
      expect(f.cacheStats()?.missesByMethod.eth_getLogs).toBeUndefined();
    });
  },
);
