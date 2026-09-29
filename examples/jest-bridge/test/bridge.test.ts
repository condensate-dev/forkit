/**
 * Bridge USDC from Base to Arbitrum through Across, with no live relayer: alice deposits into
 * Base's real SpokePool, forkit's simulated relayer fills the deposit on the Arbitrum fork
 * through Arbitrum's real SpokePool, and bob receives the USDC there.
 *
 * Addresses and ABIs, all public:
 * - Across SpokePools: https://docs.across.to/reference/contract-addresses (forkit ships the
 *   table as `across.spokePools`)
 * - SpokePool ABI: across-protocol/contracts, contracts/interfaces/V3SpokePoolInterface.sol
 *   (forkit ships it as `spokePoolAbi`)
 * - USDC on Base and Arbitrum: https://developers.circle.com/stablecoins/usdc-contract-addresses
 *
 * The two forks are pinned 20 s apart (Base first), so the deposit's deadlines, taken from Base's
 * clock, are still open when the fill is checked against Arbitrum's clock.
 */
import { fileURLToPath } from "node:url";
import { label } from "@condensate/forkit";
import { type AcrossFillDetails, across, bridge, spokePoolAbi } from "@condensate/forkit/bridges";
import { describeFork, itFork } from "@condensate/forkit/jest";
import { expect } from "@jest/globals";
import {
  type Address,
  erc20Abi,
  getAddress,
  keccak256,
  pad,
  parseEther,
  slice,
  toHex,
  zeroAddress,
} from "viem";
import { arbitrum, base } from "viem/chains";

const BASE_BLOCK = 51_930_802n;
const BASE_TIMESTAMP = 1_790_650_951; // of BASE_BLOCK
const ARB_BLOCK = 509_904_348n;
const ARB_TIMESTAMP = 1_790_650_971; // of ARB_BLOCK, 20 s later
const cacheDir = fileURLToPath(new URL("../.forkit-cache", import.meta.url));

const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const SPOKE_BASE = across.spokePools[base.id] as Address;
const SPOKE_ARB = across.spokePools[arbitrum.id] as Address;

// Addresses derived from fixed strings: empty on the real chains, the same on every run.
const who = (name: string): Address =>
  getAddress(slice(keccak256(toHex(`forkit example: ${name}`)), 12));
const alice = who("alice");
const bob = who("bob");

const INPUT = 1_000n * 10n ** 6n; // 1,000 USDC
// On Across the depositor sets the fee at quote time: fee = inputAmount - outputAmount.
// Here: 0.05 % plus 0.02 USDC, which across.outputAmount turns into an outputAmount.
const FEE = { bps: 5, fixed: 20_000n };
const OUTPUT = across.outputAmount(INPUT, FEE);

label(alice, "alice");
label(bob, "bob");
label(USDC_BASE, "USDC(base)");
label(USDC_ARB, "USDC(arb)");
label(SPOKE_BASE, "SpokePool(base)");
label(SPOKE_ARB, "SpokePool(arb)");

describeFork(
  "Across: Base USDC -> Arbitrum",
  [
    { chain: base, blockNumber: BASE_BLOCK, cacheDir },
    { chain: arbitrum, blockNumber: ARB_BLOCK, cacheDir },
  ],
  (f) => {
    const arb = f.on(arbitrum);

    /** alice holds 1 ETH for gas and exactly INPUT USDC on Base. */
    async function fundAlice() {
      await f.dealNative(alice, parseEther("1"));
      await f.deal(USDC_BASE, alice, INPUT);
    }

    /** alice deposits INPUT USDC into Base's SpokePool, for bob on Arbitrum. */
    async function deposit() {
      const b32 = (a: Address) => pad(a, { size: 32 });
      // Timestamps are absolute and fixed. Values read from the clock at run time would change
      // the deposit's relay hash on every run, and the offline recording would miss it.
      await f.prank(alice, async (c) => {
        await c.writeContract({
          address: USDC_BASE,
          abi: erc20Abi,
          functionName: "approve",
          args: [SPOKE_BASE, INPUT],
        });
        await c.writeContract({
          address: SPOKE_BASE,
          abi: spokePoolAbi,
          functionName: "deposit",
          args: [
            b32(alice), // depositor
            b32(bob), // recipient on Arbitrum
            b32(USDC_BASE), // input token
            b32(USDC_ARB), // output token
            INPUT,
            OUTPUT,
            BigInt(arbitrum.id),
            b32(zeroAddress), // no exclusive relayer
            BASE_TIMESTAMP, // quote timestamp
            BASE_TIMESTAMP + 3_600, // fill deadline: one hour
            0, // exclusivity: none
            "0x", // no message
          ],
        });
      });
    }

    itFork("the forks are pinned 20 s apart", async () => {
      expect((await f.client.getBlock()).timestamp).toBe(BigInt(BASE_TIMESTAMP));
      expect((await arb.client.getBlock()).timestamp).toBe(BigInt(ARB_TIMESTAMP));
    });

    itFork("bob receives the output on Arbitrum, and the fill reports the fee", async () => {
      // Create the simulator before the deposit: it watches from the current block on.
      const relayer = bridge.across(f);

      await fundAlice();
      await f.expectBalanceChange(USDC_BASE, alice, -INPUT, deposit);
      expect(await relayer.poll()).toHaveLength(1);

      // settle() fills every pending deposit on its destination fork, as a relayer would.
      const [fill] = await arb.expectBalanceChange(USDC_ARB, bob, OUTPUT, () => relayer.settle());
      expect(fill?.outputAmount).toBe(OUTPUT);
      expect(fill?.deposit).toMatchObject({
        originChainId: base.id,
        destinationChainId: arbitrum.id,
      });

      // `details` is typed Record<string, unknown>; for Across its shape is AcrossFillDetails.
      const details = fill?.details as unknown as AcrossFillDetails;
      expect(details.fee).toBe(across.fee(INPUT, FEE)); // 0.52 USDC
      expect(details.fee).toBe(520_000n);
      expect(details.exclusive).toBe(false);
      expect(details.relayer).toBe(across.defaultRelayer);
      expect(details.spokePool).toBe(SPOKE_ARB);
      expect(relayer.pending).toHaveLength(0);
    });

    itFork("a relayer that keeps extra: assert on what bob actually gets", async () => {
      // Override what the simulated relayer delivers, e.g. to test your app's slippage handling.
      const short = 1_234n;
      const relayer = bridge.across(f, { outputAmount: (d) => d.args.outputAmount - short });
      await fundAlice();
      await deposit();
      const [fill] = await arb.expectBalanceChange(USDC_ARB, bob, OUTPUT - short, () =>
        relayer.settle(),
      );
      expect(fill?.details).toMatchObject({
        fee: INPUT - OUTPUT + short,
        depositOutputAmount: OUTPUT,
      });
    });

    itFork("a deposit whose fill deadline has passed is not filled", async () => {
      const relayer = bridge.across(f);
      await fundAlice();
      await deposit();
      await arb.warp(2 * 3_600); // two hours on Arbitrum: past the one-hour fill deadline
      await expect(relayer.settle()).rejects.toThrow(/fillDeadline .* is before/);
      expect(relayer.pending).toHaveLength(1);
    });
  },
);
