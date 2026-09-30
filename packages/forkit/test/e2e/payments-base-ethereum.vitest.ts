/**
 * Live e2e: stablecoin payments on pinned forks of Base and Ethereum, against the real tokens and
 * Permit2 (docs/guides/payments.md).
 *
 * - Base USDC: EIP-2612 permit and transferFrom; EIP-3009 transfer and receiveWithAuthorization,
 *   with the nonce marked used and replays rejected; Permit2 SignatureTransfer and
 *   AllowanceTransfer.
 * - Ethereum USDT: approve nonzero → nonzero reverts without the helper and succeeds with it;
 *   transfer returns no bool.
 * - Ethereum USDC: blacklist and pause through the pranked blacklister and pauser.
 *
 * Public sources only:
 * - USDC (Ethereum, Base): https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - USDT (Ethereum): https://tether.to/en/supported-protocols/
 * - Permit2: https://developers.uniswap.org/docs/protocols/v4/deployments
 * - ABIs: verified sources on Etherscan, Basescan and Blockscout (FiatTokenV2_2, TetherToken,
 *   Permit2)
 *
 * Every key, address and nonce is derived from a fixed string, every deadline from the pinned
 * block's time, and blocks are mined at a fixed interval, so the recording in
 * .forkit-cache/payments replays offline on anvil 1.7 and 1.8. RPC: viem's defaults
 * (https://mainnet.base.org, https://ethereum.reth.rs/rpc; both serve archive state).
 */
import { type Address, type Chain, erc20Abi, getAbiItem, parseEther } from "viem";
import { base, mainnet } from "viem/chains";
import { beforeAll, expect } from "vitest";
import {
  expectBalanceChange,
  expectEmit,
  expectRevert,
  type Fork,
  label,
} from "../../src/index.ts";
import {
  authorizationNonce,
  blacklist,
  eip2612Abi,
  eip3009Abi,
  expectAllowance,
  expectAuthorizationUnused,
  expectAuthorizationUsed,
  expectPermit2Allowance,
  expectPermit2NonceUnused,
  expectPermit2NonceUsed,
  expectPermitNonce,
  fiatTokenAdminAbi,
  forceApprove,
  noReturnErc20Abi,
  PERMIT2,
  pause,
  permit2Abi,
  permit2Domain,
  permit2Nonce,
  safeTransfer,
  signPermit,
  signPermitSingle,
  signPermitTransferFrom,
  signReceiveWithAuthorization,
  signTransferWithAuthorization,
  testAccount,
  testAddress,
  tokenDomain,
} from "../../src/payments/index.ts";
import { describeFork, itFork } from "../../src/vitest.ts";

const CACHE_DIR = ".forkit-cache/payments";
const BASE_BLOCK = 51_950_000n;
const MAINNET_BLOCK = 26_080_000n;

const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ETH: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_ETH: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

// Each is labelled with its name, for errors, traces and the explorer.
const alice = testAccount("alice"); // signs; never needs gas for a permit or an authorization
const bob = testAddress("bob"); // spender and relayer (pranked)
const carol = testAddress("carol"); // payee
const dave = testAddress("dave"); // a USDT and USDC holder on Ethereum (pranked)

const USDC = (n: number) => BigInt(n) * 10n ** 6n;

/**
 * Mine blocks at a fixed interval from the pinned block's time, instead of anvil's wall clock.
 * anvil 1.8 runs the EIP-4788 beacon-roots system call on every block it mines, and on Ethereum
 * that call writes slot `timestamp % 8191`, which anvil first reads from the fork: with
 * wall-clock timestamps that slot, and so the recording it needs, changes every run. Base pins
 * too, so both chains' block times are the same on every run. Set once, before the per-test
 * snapshots; it is node config, so `evm_revert` keeps it.
 */
function pinBlockTimes<TChain extends Chain>(f: Fork<TChain>, seconds: number): void {
  beforeAll(async () => {
    await f.client.setBlockTimestampInterval({ interval: seconds });
  });
}

describeFork(
  "Base USDC: permit, EIP-3009 and Permit2",
  { chain: base, blockNumber: BASE_BLOCK, cacheDir: CACHE_DIR },
  (f) => {
    label(USDC_BASE, "USDC");
    pinBlockTimes(f, 2);
    /** One hour past the pinned block: deadlines come from the fork, never the wall clock. */
    const deadline = async () =>
      (await f.client.getBlock({ blockNumber: BASE_BLOCK })).timestamp + 3_600n;
    const fund = async () => {
      await f.deal(USDC_BASE, alice.address, USDC(1_000));
      await f.dealNative(bob, parseEther("1"));
    };
    /** Permit2 needs a plain ERC-20 approve first, and that one alice sends and pays for. */
    const approvePermit2 = async () => {
      await f.dealNative(alice.address, parseEther("1"));
      await forceApprove(f, {
        token: USDC_BASE,
        owner: alice.address,
        spender: PERMIT2,
        amount: USDC(1_000),
      });
    };

    itFork("Permit2 and USDC report the EIP-712 domains their signatures use", async () => {
      expect(await permit2Domain(f.client)).toEqual({
        name: "Permit2",
        chainId: base.id,
        verifyingContract: PERMIT2,
      });
      // USDC has no EIP-5267 eip712Domain(): name() and version() are read, and the result is
      // checked against its DOMAIN_SEPARATOR().
      expect(await tokenDomain(f.client, USDC_BASE)).toEqual({
        name: "USD Coin",
        version: "2",
        chainId: base.id,
        verifyingContract: USDC_BASE,
      });
    });

    itFork(
      "EIP-2612: permit, then transferFrom by the spender; the permit cannot be replayed",
      async () => {
        await fund();
        const permit = await signPermit(f.client, {
          token: USDC_BASE,
          owner: alice,
          spender: bob,
          value: USDC(250),
          deadline: await deadline(),
        });
        expect(permit.nonce).toBe(0n);

        // bob submits alice's permit and pays the gas.
        await f.prank(bob, (c) =>
          c.writeContract({
            address: USDC_BASE,
            abi: eip2612Abi,
            functionName: "permit",
            args: permit.args,
          }),
        );
        await expectAllowance(f.client, USDC_BASE, alice.address, bob, USDC(250));
        await expectPermitNonce(f.client, USDC_BASE, alice.address, 1n);

        await expectBalanceChange(f.client, USDC_BASE, carol, USDC(100), () =>
          f.prank(bob, (c) =>
            c.writeContract({
              address: USDC_BASE,
              abi: erc20Abi,
              functionName: "transferFrom",
              args: [alice.address, carol, USDC(100)],
            }),
          ),
        );
        await expectAllowance(f.client, USDC_BASE, alice.address, bob, USDC(150));

        // The nonce moved on, so the same signature now recovers to someone else.
        await f.prank(bob, (c) =>
          expectRevert(
            c.writeContract({
              address: USDC_BASE,
              abi: eip2612Abi,
              functionName: "permit",
              args: permit.args,
            }),
            "EIP2612: invalid signature",
          ),
        );
      },
    );

    itFork(
      "EIP-3009: transferWithAuthorization marks the nonce used; a replay reverts",
      async () => {
        await fund();
        const nonce = authorizationNonce("base invoice 1");
        const auth = await signTransferWithAuthorization(f.client, {
          token: USDC_BASE,
          from: alice,
          to: carol,
          value: USDC(42),
          validBefore: await deadline(),
          nonce,
        });
        await expectAuthorizationUnused(f.client, USDC_BASE, alice.address, nonce);

        // Any relayer may submit it: bob pays the gas, alice pays the USDC.
        const hash = await expectBalanceChange(f.client, USDC_BASE, carol, USDC(42), () =>
          f.prank(bob, (c) =>
            c.writeContract({
              address: USDC_BASE,
              abi: eip3009Abi,
              functionName: "transferWithAuthorization",
              args: auth.args,
            }),
          ),
        );
        const receipt = await f.client.waitForTransactionReceipt({ hash });
        expectEmit(receipt, getAbiItem({ abi: eip3009Abi, name: "AuthorizationUsed" }), {
          authorizer: alice.address,
          nonce,
        });
        await expectAuthorizationUsed(f.client, USDC_BASE, alice.address, nonce);

        await f.prank(bob, (c) =>
          expectRevert(
            c.writeContract({
              address: USDC_BASE,
              abi: eip3009Abi,
              functionName: "transferWithAuthorization",
              args: auth.args,
            }),
            "FiatTokenV2: authorization is used or canceled",
          ),
        );
      },
    );

    itFork("EIP-3009: receiveWithAuthorization only lets the payee submit", async () => {
      await fund();
      await f.dealNative(carol, parseEther("1"));
      const nonce = authorizationNonce("base invoice 2");
      const auth = await signReceiveWithAuthorization(f.client, {
        token: USDC_BASE,
        from: alice,
        to: carol,
        value: USDC(7),
        validBefore: await deadline(),
        nonce,
      });
      const submit = (by: Address) =>
        f.prank(by, (c) =>
          c.writeContract({
            address: USDC_BASE,
            abi: eip3009Abi,
            functionName: "receiveWithAuthorization",
            args: auth.args,
          }),
        );

      await expectRevert(submit(bob), "FiatTokenV2: caller must be the payee");
      await expectAuthorizationUnused(f.client, USDC_BASE, alice.address, nonce);
      await expectBalanceChange(f.client, USDC_BASE, carol, USDC(7), () => submit(carol));
      await expectAuthorizationUsed(f.client, USDC_BASE, alice.address, nonce);
      await expectRevert(submit(carol), "FiatTokenV2: authorization is used or canceled");
    });

    itFork(
      "Permit2 SignatureTransfer: permitTransferFrom spends the bitmap nonce once",
      async () => {
        await fund();
        await approvePermit2();

        const nonce = permit2Nonce("base order 1");
        const signed = await signPermitTransferFrom(f.client, {
          owner: alice,
          token: USDC_BASE,
          amount: USDC(60),
          spender: bob,
          nonce,
          deadline: await deadline(),
        });
        await expectPermit2NonceUnused(f.client, alice.address, nonce);

        const transfer = (requestedAmount: bigint) =>
          f.prank(bob, (c) =>
            c.writeContract({
              address: PERMIT2,
              abi: permit2Abi,
              functionName: "permitTransferFrom",
              args: [
                signed.permit,
                { to: carol, requestedAmount },
                alice.address,
                signed.signature,
              ],
            }),
          );

        await expectRevert(transfer(USDC(61)), "InvalidAmount(uint256)");
        await expectBalanceChange(f.client, USDC_BASE, carol, USDC(50), () => transfer(USDC(50)));
        await expectPermit2NonceUsed(f.client, alice.address, nonce);
        await expectRevert(transfer(USDC(10)), { abi: permit2Abi, errorName: "InvalidNonce" });
      },
    );

    itFork(
      "Permit2 AllowanceTransfer: permit sets a time-boxed allowance, transferFrom draws on it",
      async () => {
        await fund();
        await approvePermit2();

        const sigDeadline = await deadline();
        const expiration = Number(sigDeadline + 86_400n);
        const signed = await signPermitSingle(f.client, {
          owner: alice,
          token: USDC_BASE,
          amount: USDC(300),
          expiration,
          spender: bob,
          sigDeadline,
        });
        expect(signed.permitSingle.details.nonce).toBe(0);

        const permit = () =>
          f.prank(bob, (c) =>
            c.writeContract({
              address: PERMIT2,
              abi: permit2Abi,
              functionName: "permit",
              args: signed.args,
            }),
          );
        await permit();
        await expectPermit2Allowance(f.client, USDC_BASE, alice.address, bob, {
          amount: USDC(300),
          expiration,
          nonce: 1,
        });

        const draw = (amount: bigint) =>
          f.prank(bob, (c) =>
            c.writeContract({
              address: PERMIT2,
              abi: permit2Abi,
              functionName: "transferFrom",
              args: [alice.address, carol, amount, USDC_BASE],
            }),
          );
        await expectBalanceChange(f.client, USDC_BASE, carol, USDC(120), () => draw(USDC(120)));
        await expectPermit2Allowance(f.client, USDC_BASE, alice.address, bob, {
          amount: USDC(180),
        });
        await expectRevert(draw(USDC(181)), {
          abi: permit2Abi,
          errorName: "InsufficientAllowance",
          args: [USDC(180)],
        });
        // The ordered nonce moved to 1, so replaying the permit is rejected.
        await expectRevert(permit(), { abi: permit2Abi, errorName: "InvalidNonce" });
      },
    );
  },
);

describeFork(
  "Ethereum: USDT approve and transfer quirks, USDC blacklist and pause",
  { chain: mainnet, blockNumber: MAINNET_BLOCK, cacheDir: CACHE_DIR },
  (f) => {
    label(USDT_ETH, "USDT");
    label(USDC_ETH, "USDC");
    pinBlockTimes(f, 12);
    const isBlacklisted = (account: Address) =>
      f.client.readContract({
        address: USDC_ETH,
        abi: fiatTokenAdminAbi,
        functionName: "isBlacklisted",
        args: [account],
      });
    const paused = () =>
      f.client.readContract({ address: USDC_ETH, abi: fiatTokenAdminAbi, functionName: "paused" });

    itFork("USDT: approve nonzero → nonzero reverts without a reset", async () => {
      await f.dealNative(dave, parseEther("1"));
      await f.prank(dave, async (c) => {
        const approve = (value: bigint) =>
          c.writeContract({
            address: USDT_ETH,
            abi: noReturnErc20Abi,
            functionName: "approve",
            args: [bob, value],
          });
        await approve(100n);
        const revert = await expectRevert(approve(200n));
        // USDT uses a bare require(): no reason, no data.
        expect(revert.kind).toBe("empty");
      });
      await expectAllowance(f.client, USDT_ETH, dave, bob, 100n);
    });

    itFork("USDT: forceApprove resets to zero only when it has to", async () => {
      await f.dealNative(dave, parseEther("1"));
      const approve = (amount: bigint) =>
        forceApprove(f, { token: USDT_ETH, owner: dave, spender: bob, amount });
      expect((await approve(100n)).reset).toBe(false);
      expect((await approve(200n)).reset).toBe(true);
      await expectAllowance(f.client, USDT_ETH, dave, bob, 200n);
    });

    itFork(
      "USDT: transfer returns no bool; erc20Abi simulation fails, safeTransfer works",
      async () => {
        await f.dealNative(dave, parseEther("1"));
        await f.deal(USDT_ETH, dave, 5_000_000n);
        // viem expects the bool erc20Abi declares and cannot decode USDT's empty return data.
        await expect(
          f.client.simulateContract({
            account: dave,
            address: USDT_ETH,
            abi: erc20Abi,
            functionName: "transfer",
            args: [carol, 1_000_000n],
          }),
        ).rejects.toThrow(/"transfer" returned no data \("0x"\)/);
        await expectBalanceChange(f.client, USDT_ETH, carol, 1_000_000n, () =>
          safeTransfer(f, { token: USDT_ETH, from: dave, to: carol, amount: 1_000_000n }),
        );
      },
    );

    itFork(
      "USDC: the pranked blacklister blacklists an address; its transfers revert",
      async () => {
        await f.dealNative(dave, parseEther("1"));
        await f.deal(USDC_ETH, dave, USDC(10));
        const blacklister = await blacklist(f, USDC_ETH, dave);
        expect(blacklister).toBe(
          await f.client.readContract({
            address: USDC_ETH,
            abi: fiatTokenAdminAbi,
            functionName: "blacklister",
          }),
        );
        expect(await isBlacklisted(dave)).toBe(true);

        await expectRevert(
          safeTransfer(f, { token: USDC_ETH, from: dave, to: carol, amount: 1n }),
          "Blacklistable: account is blacklisted",
        );
        // Sending to a blacklisted address fails too.
        await f.deal(USDC_ETH, carol, USDC(1));
        await f.dealNative(carol, parseEther("1"));
        await expectRevert(
          safeTransfer(f, { token: USDC_ETH, from: carol, to: dave, amount: 1n }),
          "Blacklistable: account is blacklisted",
        );
      },
    );

    itFork("USDC: deal after blacklist clears the blacklist bit, so deal first", async () => {
      // FiatTokenV2_2 keeps the blacklist flag in the top bit of the balance slot
      // (balanceAndBlacklistStates), and deal writes the whole slot.
      await blacklist(f, USDC_ETH, dave);
      expect(await isBlacklisted(dave)).toBe(true);
      await f.deal(USDC_ETH, dave, USDC(5));
      expect(await isBlacklisted(dave)).toBe(false);
    });

    itFork("USDC: the pranked pauser pauses the token; transfers revert", async () => {
      await f.dealNative(dave, parseEther("1"));
      await f.deal(USDC_ETH, dave, USDC(10));
      await safeTransfer(f, { token: USDC_ETH, from: dave, to: carol, amount: 1n });

      const pauser = await pause(f, USDC_ETH);
      expect(pauser).toBe(
        await f.client.readContract({
          address: USDC_ETH,
          abi: fiatTokenAdminAbi,
          functionName: "pauser",
        }),
      );
      expect(await paused()).toBe(true);
      await expectRevert(
        safeTransfer(f, { token: USDC_ETH, from: dave, to: carol, amount: 1n }),
        "Pausable: paused",
      );
    });

    itFork("each test starts unpaused and unblacklisted (snapshot isolation)", async () => {
      expect(await paused()).toBe(false);
      expect(await isBlacklisted(dave)).toBe(false);
    });
  },
);
