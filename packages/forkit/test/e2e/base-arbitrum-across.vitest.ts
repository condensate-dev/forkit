/**
 * The milestone 5b end to end: Base USDC → Arbitrum via simulated Across, with no live relayer
 * and no live quote API in CI.
 *
 * 1. Production-style code asks Across's public quote API for a Base→Arbitrum USDC quote with
 *    plain `fetch`. forkit's HTTP replay serves the recorded response, pinned to the Base block.
 * 2. alice deposits into Base's SpokePool with the quoted output amount, timestamp, fill
 *    deadline and exclusive relayer.
 * 3. `bridge.across(f).settle()` fills the deposit on the Arbitrum fork through the real
 *    SpokePool, impersonating the quoted exclusive relayer.
 * 4. The recipient's Arbitrum USDC rises by exactly the quoted output, alice's Base USDC falls by
 *    the input, and the fee the simulator reports is exactly the quote's total relay fee.
 *
 * Public sources: SpokePools, docs.across.to/reference/contract-addresses; the quote API,
 * docs.across.to (suggested-fees); USDC, developers.circle.com/stablecoins/usdc-contract-addresses.
 *
 * Pins: Base 51,907,866 (timestamp 1790605079) and Arbitrum 509,730,857 (1790605099), 20 s apart,
 * so the quote, the deposit and the fill share one clock. Arbitrum's public RPC keeps only recent
 * state, so these pins were recorded right after they were chosen; fork state replays from
 * `.forkit-cache/e2e-across` and the quote from `.forkit-http/across`. To re-record, pick new
 * pins (both chains, same moment) and run with network access, FORKIT_CACHE=readwrite and
 * FORKIT_HTTP=record.
 */
import { type Address, erc20Abi, getAddress, keccak256, pad, parseEther, slice, toHex } from "viem";
import { arbitrum, base } from "viem/chains";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type AcrossFillDetails, across, spokePoolAbi } from "../../src/bridges/across.ts";
import { bridge } from "../../src/bridges/index.ts";
import { http } from "../../src/http/index.ts";
import { expectBalanceChange, type Fork, fork, label } from "../../src/index.ts";

const BASE_BLOCK = 51_907_866n;
const ARB_BLOCK = 509_730_857n;
const CACHE_DIR = ".forkit-cache/e2e-across";

const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const SPOKE_BASE = across.spokePools[base.id] as Address;
const SPOKE_ARB = across.spokePools[arbitrum.id] as Address;

// Derived from hashes, so no one holds anything there on the real chains.
const who = (name: string): Address =>
  getAddress(slice(keccak256(toHex(`forkit base-arb e2e ${name}`)), 12));
const alice = who("alice");
const bob = who("bob");

const INPUT = 1_000n * 10n ** 6n; // 1,000 USDC

/** The fields of Across's suggested-fees response this route uses. */
interface AcrossQuote {
  outputAmount: string;
  timestamp: string;
  fillDeadline: string;
  exclusiveRelayer: Address;
  totalRelayFee: { total: string };
  lpFee: { total: string };
  spokePoolAddress: Address;
  destinationSpokePoolAddress: Address;
}

/** What an app would do: ask Across for a quote, with plain fetch. */
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
  if (!response.ok) throw new Error(`Across quote failed: HTTP ${response.status}`);
  return (await response.json()) as AcrossQuote;
}

let f: Fork<typeof base>;

beforeAll(async () => {
  f = await fork([
    { chain: base, blockNumber: BASE_BLOCK, cacheDir: CACHE_DIR },
    { chain: arbitrum, blockNumber: ARB_BLOCK, cacheDir: CACHE_DIR },
  ]);
  label(alice, "alice");
  label(bob, "bob");
  label(USDC_BASE, "USDC(base)");
  label(USDC_ARB, "USDC(arb)");
  label(SPOKE_BASE, "SpokePool(base)");
  label(SPOKE_ARB, "SpokePool(arb)");
});

afterAll(async () => {
  await f?.stop();
});

test("Base USDC → Arbitrum via simulated Across: recipient paid, fee accounting matches the quote", async () => {
  const arb = f.on(arbitrum);
  const across = bridge.across(f);

  const quote = await http.with(
    {
      name: "across/base-arb-usdc",
      blockNumber: BASE_BLOCK,
      chainId: base.id,
      hosts: ["app.across.to"],
    },
    () => quoteAcross(INPUT),
  );
  expect(getAddress(quote.spokePoolAddress)).toBe(SPOKE_BASE);
  expect(getAddress(quote.destinationSpokePoolAddress)).toBe(SPOKE_ARB);
  const output = BigInt(quote.outputAmount);
  const quotedFee = BigInt(quote.totalRelayFee.total);
  expect(INPUT - output).toBe(quotedFee);

  await f.dealNative(alice, parseEther("1"));
  await f.deal(USDC_BASE, alice, INPUT);
  const b32 = (a: Address) => pad(a, { size: 32 });
  // Absolute exclusivity (quote time + 1 h), not an offset: an offset would be counted from the
  // deposit block's wall-clock time and change the relay hash on every run.
  const exclusivityDeadline = Number(quote.timestamp) + 3_600;

  await expectBalanceChange(f.client, USDC_BASE, alice, -INPUT, () =>
    f.prank(alice, async (c) => {
      await c.writeContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "approve",
        args: [SPOKE_BASE, INPUT],
      });
      return await c.writeContract({
        address: SPOKE_BASE,
        abi: spokePoolAbi,
        functionName: "deposit",
        args: [
          b32(alice),
          b32(bob),
          b32(USDC_BASE),
          b32(USDC_ARB),
          INPUT,
          output,
          BigInt(arbitrum.id),
          b32(quote.exclusiveRelayer),
          Number(quote.timestamp),
          Number(quote.fillDeadline),
          exclusivityDeadline,
          "0x",
        ],
      });
    }),
  );
  expect(across.pending).toHaveLength(0);
  expect(await across.poll()).toHaveLength(1);

  const [fill] = await expectBalanceChange(arb.client, USDC_ARB, bob, output, () =>
    across.settle(),
  );
  expect(fill?.outputAmount).toBe(output);
  expect(fill?.deposit).toMatchObject({ originChainId: base.id, destinationChainId: arbitrum.id });
  const details = fill?.details as unknown as AcrossFillDetails;
  expect(details.fee).toBe(quotedFee);
  expect(details.exclusive).toBe(true);
  expect(getAddress(details.relayer)).toBe(getAddress(quote.exclusiveRelayer));
  expect(across.pending).toHaveLength(0);
  expect(await across.settle()).toEqual([]);
});
