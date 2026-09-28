/**
 * Live e2e: fork Base at a pinned block over a real RPC, deal USDC, and swap it for WETH through
 * Uniswap v3's SwapRouter02 with calldata built from the public ABI.
 *
 * Addresses and ABIs, all from public sources:
 * - USDC on Base: Circle, https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - WETH on Base: the OP-stack predeploy 0x4200…0006
 * - SwapRouter02 and QuoterV2 on Base: Uniswap v3 deployments,
 *   https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments
 * - ABIs: Uniswap/swap-router-contracts IV3SwapRouter.sol, Uniswap/v3-periphery IQuoterV2.sol
 *
 * RPC: FORKIT_RPC_URL_8453 if set, else viem's default for Base (https://mainnet.base.org),
 * which serves archive state.
 */
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseAbi,
  parseEther,
  slice,
  toHex,
} from "viem";
import { base } from "viem/chains";
import { expect } from "vitest";
import { describeFork, itFork } from "../../src/vitest.ts";

const BLOCK = 51_800_000n;

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const SWAP_ROUTER_02: Address = "0x2626664c2603336E57B271c5C0b26F421741e481";
const QUOTER_V2: Address = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const FEE_005_PERCENT = 500;

const swapRouterAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);
const quoterAbi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// Derived from a hash, so no one holds anything there on the real chain (vanity addresses do).
const alice: Address = getAddress(slice(keccak256(toHex("forkit e2e alice")), 12));
const AMOUNT_IN = 1_000n * 10n ** 6n; // 1,000 USDC

describeFork(
  "Base: deal USDC and swap it on Uniswap v3",
  { chain: base, blockNumber: BLOCK },
  (f) => {
    const balance = (token: Address) =>
      f.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [alice],
      });

    itFork("the fork is pinned and OP-stack", async () => {
      expect(await f.client.getChainId()).toBe(base.id);
      expect(await f.client.getBlockNumber()).toBe(BLOCK);
    });

    itFork(
      "deal writes an exact USDC balance (anvil_dealERC20 and storage discovery)",
      async () => {
        await f.deal(USDC, alice, 123_456_789n);
        expect(await balance(USDC)).toBe(123_456_789n);
        await f.deal(USDC, alice, 42n, { via: "storage" });
        expect(await balance(USDC)).toBe(42n);
      },
    );

    itFork("swaps dealt USDC for WETH through SwapRouter02 calldata", async () => {
      await f.dealNative(alice, parseEther("1"));
      await f.deal(USDC, alice, AMOUNT_IN);

      const usdcBefore = await balance(USDC);
      const wethBefore = await balance(WETH);
      expect(usdcBefore).toBe(AMOUNT_IN);
      expect(wethBefore).toBe(0n);

      // The quote runs against the same pinned state, so the swap must deliver exactly this.
      const { result: quote } = await f.client.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: AMOUNT_IN,
            fee: FEE_005_PERCENT,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const [expectedOut] = quote;

      await f.prank(alice, async (c) => {
        const approve = await c.writeContract({
          address: USDC,
          abi: erc20Abi,
          functionName: "approve",
          args: [SWAP_ROUTER_02, AMOUNT_IN],
        });
        expect((await c.waitForTransactionReceipt({ hash: approve })).status).toBe("success");

        const data = encodeFunctionData({
          abi: swapRouterAbi,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: USDC,
              tokenOut: WETH,
              fee: FEE_005_PERCENT,
              recipient: alice,
              amountIn: AMOUNT_IN,
              amountOutMinimum: expectedOut,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
        const swap = await c.sendTransaction({ to: SWAP_ROUTER_02, data });
        expect((await c.waitForTransactionReceipt({ hash: swap })).status).toBe("success");
      });

      const usdcAfter = await balance(USDC);
      const wethAfter = await balance(WETH);
      console.log(
        `swap: USDC ${usdcBefore} -> ${usdcAfter}, WETH ${wethBefore} -> ${wethAfter} (quoted ${expectedOut})`,
      );
      expect(usdcBefore - usdcAfter).toBe(AMOUNT_IN);
      expect(wethAfter - wethBefore).toBe(expectedOut);
      // Sanity: 1,000 USDC buys between 0.05 and 2 WETH at any plausible ETH price.
      expect(expectedOut).toBeGreaterThan(parseEther("0.05"));
      expect(expectedOut).toBeLessThan(parseEther("2"));
    });

    itFork("each test starts from the pinned snapshot", async () => {
      expect(await balance(USDC)).toBe(0n);
      expect(await balance(WETH)).toBe(0n);
    });

    itFork("warp and roll move the fork forward", async () => {
      const before = await f.client.getBlock();
      await f.warp(86_400);
      await f.roll(5);
      const after = await f.client.getBlock();
      expect(after.number).toBe(before.number + 6n);
      expect(after.timestamp - before.timestamp).toBeGreaterThanOrEqual(86_400n);
    });
  },
);
