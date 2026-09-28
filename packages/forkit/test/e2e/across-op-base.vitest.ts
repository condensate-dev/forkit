/**
 * Live e2e: `bridge.across` on real Optimism and Base forks. A dealt holder deposits USDC into
 * Optimism's Across SpokePool; `settle()` fills it on Base through the real SpokePool, and the
 * recipient's Base USDC moves by exactly the filled amount.
 *
 * Addresses and ABIs, all from public sources:
 * - SpokePools and MulticallHandler: https://docs.across.to/reference/contract-addresses
 * - SpokePool ABI: across-protocol/contracts `contracts/interfaces/V3SpokePoolInterface.sol`
 * - USDC on Optimism and Base: Circle, https://developers.circle.com/stablecoins/usdc-contract-addresses
 *
 * Pinned blocks: Optimism 157,395,255 (timestamp 1790389287) and Base 51,800,000 (1790389347),
 * 60 s apart, so the deposit's fill deadline and exclusivity window line up across the forks.
 * Optimism's and Base's public RPCs (viem defaults) serve archive state; the fork state is
 * recorded in `.forkit-cache/across` and replays offline in CI.
 */
import {
  type Address,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  type Hex,
  keccak256,
  pad,
  parseEther,
  slice,
  toHex,
  zeroAddress,
} from "viem";
import { base, optimism } from "viem/chains";
import { expect } from "vitest";
import {
  ACROSS_MULTICALL_HANDLER,
  type AcrossFillDetails,
  across,
  spokePoolAbi,
} from "../../src/bridges/across.ts";
import { multicallHandlerInstructions } from "../../src/bridges/across-abi.ts";
import { bridge } from "../../src/bridges/index.ts";
import { describeFork, itFork } from "../../src/vitest.ts";

const OP_BLOCK = 157_395_255n;
const BASE_BLOCK = 51_800_000n;
const CACHE_DIR = ".forkit-cache/across";

const USDC_OP: Address = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SPOKE_OP = across.spokePools[optimism.id] as Address;
const SPOKE_BASE = across.spokePools[base.id] as Address;

// Derived from hashes, so no one holds anything there on the real chains.
const who = (name: string): Address =>
  getAddress(slice(keccak256(toHex(`forkit across e2e ${name}`)), 12));
const alice = who("alice");
const bob = who("bob");
const carol = who("carol (exclusive relayer)");
const dave = who("dave");

const INPUT = 1_000n * 10n ** 6n; // 1,000 USDC
const FEE = { bps: 5, fixed: 20_000n }; // 0.05 % + 0.02 USDC

interface DepositParams {
  recipient?: Address;
  outputAmount?: bigint;
  destinationChainId?: number;
  exclusiveRelayer?: Address;
  exclusivityParameter?: number;
  message?: Hex;
}

describeFork(
  "Across: Optimism USDC -> Base, filled by the simulated relayer",
  [
    { chain: optimism, blockNumber: OP_BLOCK, cacheDir: CACHE_DIR },
    { chain: base, blockNumber: BASE_BLOCK, cacheDir: CACHE_DIR },
  ],
  (f) => {
    const op = f.on(optimism);
    const baseFork = f.on(base);
    const balanceOf = { abi: erc20Abi, functionName: "balanceOf" } as const;
    const opUsdc = (holder: Address) =>
      op.client.readContract({ ...balanceOf, address: USDC_OP, args: [holder] });
    const baseUsdc = (holder: Address) =>
      baseFork.client.readContract({ ...balanceOf, address: USDC_BASE, args: [holder] });

    /** alice deposits INPUT USDC into Optimism's SpokePool. */
    async function deposit(p: DepositParams = {}) {
      await op.dealNative(alice, parseEther("1"));
      await op.deal(USDC_OP, alice, INPUT);
      const now = Number((await op.client.getBlock()).timestamp);
      const b32 = (a: Address) => pad(a, { size: 32 });
      await op.prank(alice, async (c) => {
        await c.writeContract({
          address: USDC_OP,
          abi: erc20Abi,
          functionName: "approve",
          args: [SPOKE_OP, INPUT],
        });
        await c.writeContract({
          address: SPOKE_OP,
          abi: spokePoolAbi,
          functionName: "deposit",
          args: [
            b32(alice),
            b32(p.recipient ?? bob),
            b32(USDC_OP),
            b32(USDC_BASE),
            INPUT,
            p.outputAmount ?? across.outputAmount(INPUT, FEE),
            BigInt(p.destinationChainId ?? base.id),
            b32(p.exclusiveRelayer ?? zeroAddress),
            now,
            now + 3_600,
            p.exclusivityParameter ?? 0,
            p.message ?? "0x",
          ],
        });
      });
    }

    itFork(
      "fills a deposit on Base: the recipient gets outputAmount, the fee is reported",
      async () => {
        const b = bridge.across(f);
        const expected = across.outputAmount(INPUT, FEE);
        expect(expected).toBe(INPUT - 500_000n - 20_000n);

        const poolBefore = await opUsdc(SPOKE_OP);
        await deposit();
        expect(await opUsdc(alice)).toBe(0n);
        expect((await opUsdc(SPOKE_OP)) - poolBefore).toBe(INPUT);

        const [seen] = await b.poll();
        expect(seen).toMatchObject({
          originChainId: optimism.id,
          destinationChainId: base.id,
          address: SPOKE_OP,
          args: {
            event: "FundsDeposited",
            depositor: alice,
            recipient: bob,
            inputToken: getAddress(USDC_OP),
            outputToken: getAddress(USDC_BASE),
            inputAmount: INPUT,
            outputAmount: expected,
            destinationChainId: BigInt(base.id),
            exclusiveRelayer: zeroAddress,
            exclusivityDeadline: 0,
            message: "0x",
          },
        });

        const fills = await baseFork.expectBalanceChange(USDC_BASE, bob, expected, () =>
          b.settle(),
        );
        expect(fills).toHaveLength(1);
        const [fill] = fills;
        expect(fill?.outputAmount).toBe(expected);
        expect(fill?.txHashes.length).toBeGreaterThan(0);
        expect(fill?.details).toEqual({
          fee: INPUT - expected,
          depositOutputAmount: expected,
          relayer: across.defaultRelayer,
          exclusive: false,
          repaymentChainId: base.id,
          spokePool: SPOKE_BASE,
          fillFunction: "fillRelay",
        } satisfies AcrossFillDetails);
        // The relayer was dealt exactly the output and spent it all.
        expect(await baseUsdc(across.defaultRelayer)).toBe(0n);
        expect(b.pending).toHaveLength(0);
        expect(b.fills).toHaveLength(1);
        expect(await b.settle()).toEqual([]);
      },
    );

    itFork("an open exclusivity window: the exclusive relayer fills", async () => {
      const b = bridge.across(f);
      // An absolute deadline 10 minutes out. (An offset, e.g. 600, adds the deposit block's
      // timestamp, which follows the wall clock on a fork, so the relay hash would change run to
      // run and miss the offline cache.)
      const now = Number((await op.client.getBlock()).timestamp);
      await deposit({ exclusiveRelayer: carol, exclusivityParameter: now + 600 });
      const [fill] = await b.settle();
      expect(fill?.deposit.args.exclusiveRelayer).toBe(carol);
      expect(fill?.details).toMatchObject({ relayer: carol, exclusive: true });
      expect(await baseUsdc(bob)).toBe(across.outputAmount(INPUT, FEE));
    });

    itFork("a closed exclusivity window: the default relayer fills", async () => {
      const b = bridge.across(f);
      // An absolute deadline one second after the deposit: past on Base, which is 60 s ahead.
      const now = Number((await op.client.getBlock()).timestamp);
      await deposit({ exclusiveRelayer: carol, exclusivityParameter: now + 1 });
      const [fill] = await b.settle();
      expect(fill?.details).toMatchObject({ relayer: across.defaultRelayer, exclusive: false });
      expect(await baseUsdc(bob)).toBe(across.outputAmount(INPUT, FEE));
    });

    itFork(
      "a message runs for real: MulticallHandler forwards to its fallback recipient",
      async () => {
        const b = bridge.across(f);
        const message = encodeAbiParameters(multicallHandlerInstructions, [
          { calls: [], fallbackRecipient: dave },
        ]);
        await deposit({ recipient: ACROSS_MULTICALL_HANDLER, message });
        const expected = across.outputAmount(INPUT, FEE);
        await baseFork.expectBalanceChange(USDC_BASE, dave, expected, () => b.settle());
        expect(b.fills[0]?.deposit.args.message).toBe(message);
      },
    );

    itFork("outputAmount override: model slippage and assert on the economics", async () => {
      const slip = 1_234n;
      const b = bridge.across(f, { outputAmount: (d) => d.args.outputAmount - slip });
      await deposit();
      const quoted = across.outputAmount(INPUT, FEE);
      const [fill] = await baseFork.expectBalanceChange(USDC_BASE, bob, quoted - slip, () =>
        b.settle(),
      );
      expect(fill?.outputAmount).toBe(quoted - slip);
      expect(fill?.details).toMatchObject({
        fee: INPUT - quoted + slip,
        depositOutputAmount: quoted,
      });
    });

    itFork("a deposit to a chain that is not forked fails clearly", async () => {
      const b = bridge.across(f);
      await deposit({ destinationChainId: 42_161 });
      await expect(b.settle()).rejects.toThrow(/destination chain 42161 is not in this fork/);
    });
  },
);
