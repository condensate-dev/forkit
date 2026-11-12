/**
 * Fork Base and Optimism side by side, one anvil each, and work on both in the same test:
 * wrap ETH into WETH on Base, send USDC on Optimism. Then check that the next test starts clean
 * on both chains, and that each chain keeps its own clock.
 *
 * Addresses and ABIs, all public:
 * - USDC on Optimism: https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - WETH on Base and Optimism: the OP-stack predeploy 0x4200…0006 (WETH9),
 *   https://docs.optimism.io/stack/smart-contracts/predeploys
 * - WETH9's `deposit()`: the canonical WETH9 source, verified on both chains' explorers
 */
import { expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { label } from "@condensate_dev/forkit";
import { describeFork, itFork } from "@condensate_dev/forkit/bun";
import {
  type Address,
  erc20Abi,
  getAddress,
  keccak256,
  parseAbi,
  parseEther,
  slice,
  toHex,
} from "viem";
import { base, optimism } from "viem/chains";

// Pinned 60 s apart (Base at timestamp 1790389347, Optimism at 1790389287).
const BASE_BLOCK = 51_800_000n;
const OP_BLOCK = 157_395_255n;
/** One recording directory for both chains: <cacheDir>/<chainId>/<block>.json. */
const cacheDir = fileURLToPath(new URL("../.forkit-cache", import.meta.url));

const WETH: Address = "0x4200000000000000000000000000000000000006"; // same predeploy on both
const USDC_OP: Address = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const wethAbi = parseAbi(["function deposit() payable"]);

// Addresses derived from fixed strings: empty on the real chains, the same on every run.
const who = (name: string): Address =>
  getAddress(slice(keccak256(toHex(`forkit example: ${name}`)), 12));
const alice = who("alice");
const bob = who("bob");

label(alice, "alice");
label(bob, "bob");
label(WETH, "WETH");
label(USDC_OP, "USDC(op)");

describeFork(
  "Base + Optimism",
  // The first target is the selected chain: `f` acts on Base, `f.on(optimism)` on Optimism.
  [
    { chain: base, blockNumber: BASE_BLOCK, cacheDir },
    { chain: optimism, blockNumber: OP_BLOCK, cacheDir },
  ],
  (f) => {
    // Works while tests are being collected: the handle resolves once the forks are up.
    const op = f.on(optimism);

    itFork("each chain is its own anvil, pinned to its own block", async () => {
      expect(f.chain.id).toBe(base.id);
      expect(op.chain.id).toBe(optimism.id);
      expect(await f.client.getChainId()).toBe(base.id);
      expect(await op.client.getChainId()).toBe(optimism.id);
      expect(await f.client.getBlockNumber()).toBe(BASE_BLOCK);
      expect(await op.client.getBlockNumber()).toBe(OP_BLOCK);
      expect(f.rpcUrl).not.toBe(op.rpcUrl);
      // Either handle reaches every chain.
      expect(op.on(base).chain.id).toBe(base.id);
      expect(f.forks.map((x) => x.chain.id)).toEqual([base.id, optimism.id]);
    });

    itFork("wraps ETH on Base and sends USDC on Optimism", async () => {
      // Base: alice wraps 1 ETH through the real WETH9 contract.
      await f.dealNative(alice, parseEther("2"));
      await f.expectBalanceChange(WETH, alice, parseEther("1"), () =>
        f.prank(alice, (c) =>
          c.writeContract({
            address: WETH,
            abi: wethAbi,
            functionName: "deposit",
            value: parseEther("1"),
          }),
        ),
      );

      // Optimism: alice sends 250 USDC to bob through Circle's real FiatToken.
      await op.dealNative(alice, parseEther("1"));
      await op.deal(USDC_OP, alice, 1_000n * 10n ** 6n);
      await op.expectBalanceChange(USDC_OP, bob, 250n * 10n ** 6n, () =>
        op.prank(alice, (c) =>
          c.writeContract({
            address: USDC_OP,
            abi: erc20Abi,
            functionName: "transfer",
            args: [bob, 250n * 10n ** 6n],
          }),
        ),
      );

      // Neither chain sees the other's state: alice has no WETH on Optimism.
      const wethOnOp = await op.client.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [alice],
      });
      expect(wethOnOp).toBe(0n);
    });

    itFork("the next test starts clean on both chains", async () => {
      // describeFork snapshots every chain before each test and reverts every chain after it.
      const wethOnBase = await f.client.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [alice],
      });
      const bobUsdc = await op.client.readContract({
        address: USDC_OP,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [bob],
      });
      expect(wethOnBase).toBe(0n);
      expect(bobUsdc).toBe(0n);
      expect(await f.client.getBalance({ address: alice })).toBe(0n);
      expect(await f.client.getBlockNumber()).toBe(BASE_BLOCK);
      expect(await op.client.getBlockNumber()).toBe(OP_BLOCK);
    });

    itFork("each chain keeps its own clock", async () => {
      const baseBefore = await f.client.getBlock();
      const opBefore = await op.client.getBlock();
      await op.warp(86_400); // one day on Optimism only (mines one block there)
      const opAfter = await op.client.getBlock();
      expect(opAfter.number).toBe(opBefore.number + 1n);
      expect(opAfter.timestamp - opBefore.timestamp).toBeGreaterThanOrEqual(86_400n);
      expect(await f.client.getBlock()).toMatchObject({
        number: baseBefore.number,
        timestamp: baseBefore.timestamp,
      });
    });
  },
);
