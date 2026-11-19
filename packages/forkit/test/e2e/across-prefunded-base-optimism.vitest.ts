/**
 * Live e2e: an Across prefunded order from Base to Optimism on two real forks at pinned blocks.
 * The funds go into Across's real PrefundedAdapter on Base with `store`; a simulated relayer pays
 * the registered order on Optimism.
 *
 * Addresses, all from public sources:
 * - PrefundedAdapter (Base): verified on Basescan,
 *   https://basescan.org/address/0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94#code
 * - USDC on Base and on Optimism: Circle, https://developers.circle.com/stablecoins/usdc-contract-addresses
 *
 * RPCs: FORKIT_RPC_URL_8453 / FORKIT_RPC_URL_10 if set, else viem's defaults. Recorded to
 * .forkit-cache/across-prefunded, so CI replays it offline. The two blocks are 2 s apart.
 */
import {
  type Address,
  erc20Abi,
  getAddress,
  type Hex,
  keccak256,
  parseEther,
  slice,
  toHex,
  zeroAddress,
} from "viem";
import { base, optimism } from "viem/chains";
import { expect } from "vitest";
import { acrossPrefunded } from "../../src/bridges/across-prefunded.ts";
import { describeFork, itFork } from "../../src/vitest.ts";

const BASE_BLOCK = 58_500_000n;
const OPTIMISM_BLOCK = 159_645_800n;
const CACHE_DIR = ".forkit-cache/across-prefunded";

const ADAPTER = acrossPrefunded.ADAPTER_BASE;
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_OPTIMISM: Address = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";

// Derived from hashes, so no one holds anything there on the real chains.
const who = (name: string): Address =>
  getAddress(slice(keccak256(toHex(`forkit e2e ${name}`)), 12));
const alice = who("across prefunded alice");
const bob = who("across prefunded bob");
const orderId = (name: string): Hex => keccak256(toHex(`forkit e2e across prefunded ${name}`));

describeFork(
  "Across prefunded order: Base -> Optimism through a simulated relayer",
  [
    { chain: base, blockNumber: BASE_BLOCK, cacheDir: CACHE_DIR },
    { chain: optimism, blockNumber: OPTIMISM_BLOCK, cacheDir: CACHE_DIR },
  ],
  (f) => {
    const stored = (id: Hex, token: Address) =>
      f.client.readContract({
        address: ADAPTER,
        abi: acrossPrefunded.adapterAbi,
        functionName: "storedFunding",
        args: [id, token],
      });

    itFork("the forks are pinned and the adapter is there", async () => {
      expect(await f.client.getBlockNumber()).toBe(BASE_BLOCK);
      expect(await f.on(optimism).client.getBlockNumber()).toBe(OPTIMISM_BLOCK);
      expect(await f.client.getCode({ address: ADAPTER })).toMatch(/^0x6080/);
    });

    itFork("USDC: store on Base, the relayer pays the order on Optimism", async () => {
      const b = acrossPrefunded(f, { adapters: { [base.id]: ADAPTER } });
      const id = orderId("usdc");
      const input = 1_000n * 10n ** 6n;
      const output = 999_400_000n;
      b.expect(id, {
        destinationChainId: optimism.id,
        token: USDC_OPTIMISM,
        amount: output,
        recipient: bob,
      });

      await f.dealNative(alice, parseEther("1"));
      await f.deal(USDC_BASE, alice, input);
      await f.prank(alice, async (c) => {
        await c.writeContract({
          address: USDC_BASE,
          abi: erc20Abi,
          functionName: "approve",
          args: [ADAPTER, input],
        });
        await c.writeContract({
          address: ADAPTER,
          abi: acrossPrefunded.adapterAbi,
          functionName: "store",
          args: [id, USDC_BASE, input],
        });
      });
      // The real adapter holds the funds under the order id.
      expect(await stored(id, USDC_BASE)).toBe(input);

      const [deposit] = await b.poll();
      expect(deposit).toMatchObject({
        originChainId: base.id,
        destinationChainId: optimism.id,
        address: ADAPTER,
        args: { orderId: id, token: USDC_BASE, amount: input },
      });

      const fills = await b.settle();
      expect(fills).toHaveLength(1);
      expect(fills[0]).toMatchObject({
        destinationChainId: optimism.id,
        outputAmount: output,
        details: {
          orderId: id,
          relayer: b.relayer,
          inputToken: USDC_BASE,
          inputAmount: input,
          recipient: bob,
          token: USDC_OPTIMISM,
          topUp: false,
        },
      });
      expect(fills[0]?.txHashes).toHaveLength(1);
      const usdc = { address: USDC_OPTIMISM, abi: erc20Abi, functionName: "balanceOf" } as const;
      expect(await f.on(optimism).client.readContract({ ...usdc, args: [bob] })).toBe(output);
      expect(await f.on(optimism).client.readContract({ ...usdc, args: [b.relayer] })).toBe(0n);
      expect(await b.settle()).toEqual([]);
    });

    itFork("ETH: native currency sent to store is credited under the zero address", async () => {
      const b = acrossPrefunded(f, { adapters: { [base.id]: ADAPTER } });
      const id = orderId("eth");
      const input = parseEther("0.5");
      const output = parseEther("0.499");
      b.expect(id, {
        destinationChainId: optimism.id,
        token: zeroAddress,
        amount: output,
        recipient: bob,
      });

      await f.dealNative(alice, parseEther("1"));
      await f.prank(alice, (c) =>
        c.writeContract({
          address: ADAPTER,
          abi: acrossPrefunded.adapterAbi,
          functionName: "store",
          // No token amount: the adapter then takes only the value.
          args: [id, zeroAddress, 0n],
          value: input,
        }),
      );
      expect(await stored(id, zeroAddress)).toBe(input);

      const [fill] = await b.settle();
      expect(fill?.deposit.args).toEqual({ orderId: id, token: zeroAddress, amount: input });
      expect(fill?.outputAmount).toBe(output);
      expect(await f.on(optimism).client.getBalance({ address: bob })).toBe(output);
    });
  },
);
