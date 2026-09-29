/**
 * Fork Base at a pinned block, give a fresh account 1,000 USDC, and swap it for WETH on
 * Uniswap v3. The swap is plain calldata against the real SwapRouter02, so this is the same code
 * path a wallet or backend would take on mainnet.
 *
 * Addresses and ABIs, all public:
 * - USDC on Base: https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - WETH on Base: the OP-stack predeploy 0x4200…0006
 * - SwapRouter02 and QuoterV2 on Base:
 *   https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments
 * - ABIs: IV3SwapRouter.sol (Uniswap/swap-router-contracts), IQuoterV2.sol (Uniswap/v3-periphery)
 */
import { fileURLToPath } from "node:url";
import { expectRevert, label } from "@condensate/forkit";
import { describeFork, itFork } from "@condensate/forkit/vitest";
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

/** Every run forks this block, so state (and the recording in .forkit-cache) never changes. */
const BLOCK = 51_800_000n;
/** The recording lives next to this example, whatever directory the tests run from. */
const cacheDir = fileURLToPath(new URL("../.forkit-cache", import.meta.url));
const gasSnapshotFile = fileURLToPath(new URL("../.gas-snapshot", import.meta.url));

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const SWAP_ROUTER_02: Address = "0x2626664c2603336E57B271c5C0b26F421741e481";
const QUOTER_V2: Address = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const POOL_FEE = 500; // the 0.05 % USDC/WETH pool

const swapRouterAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);
const quoterAbi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// An address derived from a fixed string: nobody holds anything there on the real chain, and it
// is the same on every run.
const alice: Address = getAddress(slice(keccak256(toHex("forkit example: alice")), 12));
const AMOUNT_IN = 1_000n * 10n ** 6n; // 1,000 USDC (6 decimals)

// Labels name addresses in assertion errors and revert traces, like Foundry's vm.label.
label(alice, "alice");
label(USDC, "USDC");
label(WETH, "WETH");
label(SWAP_ROUTER_02, "SwapRouter02");

const swapCalldata = (amountOutMinimum: bigint) =>
  encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: USDC,
        tokenOut: WETH,
        fee: POOL_FEE,
        recipient: alice,
        amountIn: AMOUNT_IN,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

// One anvil for the whole block. Every itFork starts from the same snapshot of the pinned
// block and is reverted afterwards, so tests cannot leak state into each other.
describeFork(
  "Base: swap USDC for WETH on Uniswap v3",
  { chain: base, blockNumber: BLOCK, cacheDir, gasSnapshotFile },
  (f) => {
    /** alice holds 1 ETH for gas and exactly AMOUNT_IN USDC, and has approved the router. */
    async function fundAlice() {
      await f.dealNative(alice, parseEther("1"));
      await f.deal(USDC, alice, AMOUNT_IN);
      await f.prank(alice, (c) =>
        c.writeContract({
          address: USDC,
          abi: erc20Abi,
          functionName: "approve",
          args: [SWAP_ROUTER_02, AMOUNT_IN],
        }),
      );
    }

    /** What the pool pays for AMOUNT_IN right now. The quote reads the same pinned state. */
    async function quote(): Promise<bigint> {
      const { result } = await f.client.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: AMOUNT_IN,
            fee: POOL_FEE,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      return result[0];
    }

    itFork("swaps 1,000 USDC for exactly the quoted WETH", async () => {
      await fundAlice();
      const expectedOut = await quote();
      // Sanity: 1,000 USDC buys between 0.05 and 2 WETH at any plausible ETH price.
      expect(expectedOut).toBeGreaterThan(parseEther("0.05"));
      expect(expectedOut).toBeLessThan(parseEther("2"));

      // Each expectBalanceChange reads the balance before and after the callback and fails unless
      // it moved by exactly this much. Negative means a decrease.
      await f.expectBalanceChange(USDC, alice, -AMOUNT_IN, () =>
        f.expectBalanceChange(WETH, alice, expectedOut, () =>
          f.prank(alice, (c) =>
            // Records the swap's gas in .gas-snapshot, like `forge snapshot`. In CI (CI is set)
            // it checks the committed value instead, and fails if the gas changed.
            f.gasSnapshot("swap 1,000 USDC -> WETH (exactInputSingle)", () =>
              c.sendTransaction({ to: SWAP_ROUTER_02, data: swapCalldata(expectedOut) }),
            ),
          ),
        ),
      );
    });

    itFork("reverts when the pool cannot meet amountOutMinimum", async () => {
      await fundAlice();
      const expectedOut = await quote();
      // Ask for one wei more than the pool pays. SwapRouter02 reverts with "Too little received".
      await expectRevert(
        f.prank(alice, (c) =>
          c.sendTransaction({ to: SWAP_ROUTER_02, data: swapCalldata(expectedOut + 1n) }),
        ),
        "Too little received",
      );
    });

    itFork("each test starts from the pinned block again", async () => {
      // The swap in the first test was reverted along with everything else it did.
      expect(await f.client.getBlockNumber()).toBe(BLOCK);
      const balance = (token: Address) =>
        f.client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [alice],
        });
      expect(await balance(USDC)).toBe(0n);
      expect(await balance(WETH)).toBe(0n);
    });
  },
);
