/**
 * Live e2e: Circle CCTP v1 and v2 burns on Base, credited on OP Mainnet, on two real forks at
 * pinned blocks. The burns go through Circle's real TokenMessengers on Base. The destination
 * token comes from OP Mainnet's real TokenMinter (`getLocalToken`).
 *
 * Addresses, all from public sources:
 * - TokenMessengerV2 and the v1 TokenMessenger on Base, and the domains: Circle's docs,
 *   https://developers.circle.com/cctp, checked on chain (see src/bridges/cctp.ts).
 * - `depositForBurn` of each version: https://github.com/circlefin/evm-cctp-contracts.
 * - USDC on Base and on OP Mainnet: https://developers.circle.com/stablecoins/usdc-contract-addresses
 *
 * RPCs: FORKIT_RPC_URL_8453 / FORKIT_RPC_URL_10 if set, else viem's defaults. Recorded to
 * .forkit-cache/cctp, so CI replays it offline. The two blocks are 2 s apart.
 */
import {
  type Address,
  erc20Abi,
  getAddress,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  slice,
  toHex,
} from "viem";
import { base, optimism } from "viem/chains";
import { expect } from "vitest";
import { cctp } from "../../src/bridges/cctp.ts";
import { describeFork, itFork } from "../../src/vitest.ts";

const BASE_BLOCK = 58_500_000n;
const OPTIMISM_BLOCK = 159_645_800n;
const CACHE_DIR = ".forkit-cache/cctp";

const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_OPTIMISM: Address = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const MESSENGER_V1_BASE: Address = "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962";
const MESSENGER_V2 = cctp.tokenMessengerV2;
const OPTIMISM_DOMAIN = 2;

const v1Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64 nonce)",
]);
const v2Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
]);

// Derived from hashes, so no one holds anything there on the real chains.
const who = (name: string): Address =>
  getAddress(slice(keccak256(toHex(`forkit e2e ${name}`)), 12));
const alice = who("cctp alice");
const bob = who("cctp bob");

describeFork(
  "Circle CCTP: Base -> OP Mainnet, credited by deal",
  [
    { chain: base, blockNumber: BASE_BLOCK, cacheDir: CACHE_DIR },
    { chain: optimism, blockNumber: OPTIMISM_BLOCK, cacheDir: CACHE_DIR },
  ],
  (f) => {
    const usdcOf = (holder: Address) =>
      f.on(optimism).client.readContract({
        address: USDC_OPTIMISM,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [holder],
      });

    const burn = async (messenger: Address, amount: bigint, send: () => Promise<unknown>) => {
      await f.dealNative(alice, parseEther("1"));
      await f.deal(USDC_BASE, alice, amount);
      await f.prank(alice, (c) =>
        c.writeContract({
          address: USDC_BASE,
          abi: erc20Abi,
          functionName: "approve",
          args: [messenger, amount],
        }),
      );
      await send();
      // The real TokenMessenger burned it.
      expect(
        await f.client.readContract({
          address: USDC_BASE,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [alice],
        }),
      ).toBe(0n);
    };

    itFork("v1: depositForBurn on Base credits the mint recipient on OP Mainnet", async () => {
      const b = cctp(f);
      const amount = 250n * 10n ** 6n;
      await burn(MESSENGER_V1_BASE, amount, () =>
        f.prank(alice, (c) =>
          c.writeContract({
            address: MESSENGER_V1_BASE,
            abi: v1Abi,
            functionName: "depositForBurn",
            args: [amount, OPTIMISM_DOMAIN, pad(bob), USDC_BASE],
          }),
        ),
      );
      const [fill, ...rest] = await b.settle();
      expect(rest).toEqual([]);
      expect(fill).toMatchObject({
        destinationChainId: optimism.id,
        outputAmount: amount,
        txHashes: [],
        details: { version: 1, token: USDC_OPTIMISM, recipient: bob, fee: 0n, credit: "deal" },
      });
      expect(fill?.deposit.args).toMatchObject({ version: 1, burnToken: USDC_BASE, amount });
      expect(await usdcOf(bob)).toBe(amount);
    });

    itFork("v2: a Fast Transfer keeps maxFee by default", async () => {
      const b = cctp(f);
      const amount = 100n * 10n ** 6n;
      const maxFee = 10_000n;
      await burn(MESSENGER_V2, amount, () =>
        f.prank(alice, (c) =>
          c.writeContract({
            address: MESSENGER_V2,
            abi: v2Abi,
            functionName: "depositForBurn",
            args: [amount, OPTIMISM_DOMAIN, pad(bob), USDC_BASE, pad("0x"), maxFee, 1000],
          }),
        ),
      );
      const [fill] = await b.settle();
      expect(fill?.deposit.args).toMatchObject({
        version: 2,
        amount,
        maxFee,
        minFinalityThreshold: 1000,
      });
      expect(fill?.outputAmount).toBe(amount - maxFee);
      expect(await usdcOf(bob)).toBe(amount - maxFee);
    });
  },
);
