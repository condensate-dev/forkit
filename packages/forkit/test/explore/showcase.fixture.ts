/**
 * The explorer's showcase run: what `forkit explore`'s screenshot test renders. It is not part of
 * any test gate; `bun run explore:fixture` runs it with recording on and writes the run record to
 * test/fixtures/explore/showcase.json. It reuses the e2e pins and recordings (Base + Arbitrum for
 * Across, Base for the Uniswap swap), and one test fails on purpose so the record shows a failure.
 */
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  slice,
  toHex,
} from "viem";
import { arbitrum, base } from "viem/chains";
import { beforeAll, expect } from "vitest";
import { across, spokePoolAbi } from "../../src/bridges/across.ts";
import { bridge } from "../../src/bridges/index.ts";
import { http } from "../../src/http/index.ts";
import { expectRevert, label } from "../../src/index.ts";
import { describeFork, itFork } from "../../src/vitest.ts";

const CACHE_DIR = process.env.SHOWCASE_CACHE_DIR ?? ".forkit-cache";
const who = (name: string): Address =>
  getAddress(slice(keccak256(toHex(`forkit base-arb e2e ${name}`)), 12));
const alice = who("alice");
const bob = who("bob");
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const SWAP_ROUTER_02: Address = "0x2626664c2603336E57B271c5C0b26F421741e481";
const SPOKE_BASE = across.spokePools[base.id] as Address;
const SPOKE_ARB = across.spokePools[arbitrum.id] as Address;
const INPUT = 1_000n * 10n ** 6n;

const swapRouterAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

interface AcrossQuote {
  outputAmount: string;
  timestamp: string;
  fillDeadline: string;
  exclusiveRelayer: Address;
}

async function quoteAcross(amount: bigint): Promise<AcrossQuote> {
  const url = new URL("https://app.across.to/api/suggested-fees");
  url.search = new URLSearchParams({
    inputToken: USDC_BASE,
    outputToken: USDC_ARB,
    originChainId: String(base.id),
    destinationChainId: String(arbitrum.id),
    amount: amount.toString(),
  }).toString();
  const response = await fetch(url);
  return (await response.json()) as AcrossQuote;
}

beforeAll(() => {
  label(alice, "alice");
  label(bob, "bob");
  label(USDC_BASE, "USDC(base)");
  label(USDC_ARB, "USDC(arb)");
  label(SPOKE_BASE, "SpokePool(base)");
  label(SPOKE_ARB, "SpokePool(arb)");
  label(WETH, "WETH");
  label(SWAP_ROUTER_02, "SwapRouter02");
});

describeFork(
  "Base → Arbitrum via simulated Across",
  [
    { chain: base, blockNumber: 51_907_866n, cacheDir: `${CACHE_DIR}/e2e-across` },
    { chain: arbitrum, blockNumber: 509_730_857n, cacheDir: `${CACHE_DIR}/e2e-across` },
  ],
  (f) => {
    const deposit = async (amount: bigint, output: bigint, quote: AcrossQuote) =>
      await f.prank(alice, async (c) => {
        await c.writeContract({
          address: USDC_BASE,
          abi: erc20Abi,
          functionName: "approve",
          args: [SPOKE_BASE, amount],
        });
        const b32 = (a: Address) => pad(a, { size: 32 });
        return await c.writeContract({
          address: SPOKE_BASE,
          abi: spokePoolAbi,
          functionName: "deposit",
          args: [
            b32(alice),
            b32(bob),
            b32(USDC_BASE),
            b32(USDC_ARB),
            amount,
            output,
            BigInt(arbitrum.id),
            b32(quote.exclusiveRelayer),
            Number(quote.timestamp),
            Number(quote.fillDeadline),
            Number(quote.timestamp) + 3_600,
            "0x",
          ],
        });
      });
    const quote = () =>
      http.with(
        {
          name: "across/base-arb-usdc",
          blockNumber: 51_907_866n,
          chainId: base.id,
          hosts: ["app.across.to"],
        },
        () => quoteAcross(INPUT),
      );

    itFork("bridges 1,000 USDC to bob on Arbitrum", async () => {
      const relayer = bridge.across(f);
      const q = await quote();
      await f.dealNative(alice, parseEther("1"));
      await f.deal(USDC_BASE, alice, INPUT);
      await deposit(INPUT, BigInt(q.outputAmount), q);
      const [fill] = await relayer.settle();
      expect(fill?.outputAmount).toBe(BigInt(q.outputAmount));
    });

    itFork("a deposit above alice's balance reverts", async () => {
      const q = await quote();
      await f.dealNative(alice, parseEther("1"));
      await f.deal(USDC_BASE, alice, 10n * 10n ** 6n);
      await expectRevert(deposit(INPUT, BigInt(q.outputAmount), q));
    });

    itFork("fails on purpose: expects bob to receive the full input", async () => {
      const q = await quote();
      expect(BigInt(q.outputAmount), "the relay fee comes out of the output").toBe(INPUT);
    });
  },
);

describeFork(
  "Base: swap USDC for WETH on Uniswap v3",
  { chain: base, blockNumber: 51_800_000n, cacheDir: CACHE_DIR },
  (f) => {
    itFork("swaps 1,000 USDC for WETH through SwapRouter02", async () => {
      await f.dealNative(alice, parseEther("1"));
      await f.deal(USDC_BASE, alice, INPUT);
      await f.warp(60);
      await f.prank(alice, async (c) => {
        await c.writeContract({
          address: USDC_BASE,
          abi: erc20Abi,
          functionName: "approve",
          args: [SWAP_ROUTER_02, INPUT],
        });
        await f.gasSnapshot("uniswap exactInputSingle", () =>
          c.writeContract({
            address: SWAP_ROUTER_02,
            abi: swapRouterAbi,
            functionName: "exactInputSingle",
            args: [
              {
                tokenIn: USDC_BASE,
                tokenOut: WETH,
                fee: 500,
                recipient: alice,
                amountIn: INPUT,
                amountOutMinimum: 0n,
                sqrtPriceLimitX96: 0n,
              },
            ],
          }),
        );
      });
    });

    itFork("each test starts from the pinned snapshot", async () => {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [alice] });
      expect(await f.client.call({ to: WETH, data })).toMatchObject({ data: pad("0x0") });
      // And a test can take its own: deal, look, go back.
      const id = await f.snapshot();
      await f.deal(WETH, alice, parseEther("2"));
      expect(await f.client.call({ to: WETH, data })).toMatchObject({
        data: pad(toHex(parseEther("2"))),
      });
      await f.revertTo(id);
      expect(await f.client.call({ to: WETH, data })).toMatchObject({ data: pad("0x0") });
    });
  },
);
