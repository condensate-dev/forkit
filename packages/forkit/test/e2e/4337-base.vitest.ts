/**
 * Live e2e: an ERC-4337 bundler (alto) on a Base fork. User operations from real smart-account
 * implementations, built by viem's account helpers, land through forked EntryPoints.
 *
 * Public sources only:
 * - EntryPoint addresses (v0.6 to v0.9): viem's `entryPoint0xAddress` constants.
 * - Coinbase Smart Wallet (factory v1.1, EntryPoint v0.6) and the Simple7702 account
 *   (EntryPoint v0.8): viem's `toCoinbaseSmartAccount` / `toSimple7702SmartAccount`.
 * - USDC on Base: Circle, https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - alto's flags: `alto --help` and https://docs.pimlico.io/references/bundler/self-host
 *
 * Every key is derived from a fixed string, so every run touches the same accounts and the fork
 * recording (.forkit-cache/4337) replays offline in CI. Each test builds its account afresh: viem
 * remembers that an account is deployed, and per-test revert undeploys it.
 */
import {
  type Address,
  erc20Abi,
  getAbiItem,
  getAddress,
  keccak256,
  parseEther,
  slice,
  toHex,
} from "viem";
import {
  entryPoint06Address,
  entryPoint07Address,
  entryPoint08Address,
  entryPoint09Address,
  toCoinbaseSmartAccount,
  toSimple7702SmartAccount,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { afterAll, beforeAll, expect } from "vitest";
import { type Bundler, bundler } from "../../src/4337/index.ts";
import { expectEmit, NATIVE } from "../../src/index.ts";
import { describeFork, itFork } from "../../src/vitest.ts";

const BLOCK = 51_900_000n;
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const keyOf = (name: string) => keccak256(toHex(`forkit e2e 4337 ${name}`));
const addressOf = (name: string): Address => getAddress(slice(keyOf(name), 12));
const recipient = addressOf("recipient");

describeFork(
  "Base: user operations through a forked alto bundler",
  { chain: base, blockNumber: BLOCK, cacheDir: ".forkit-cache/4337" },
  (f) => {
    let b: Bundler;
    // Before any snapshot: alto deploys its helpers and forkit funds the executor at startup.
    beforeAll(async () => {
      b = await bundler(f);
    });
    afterAll(async () => {
      await b?.stop();
    });

    const coinbaseAccount = () =>
      toCoinbaseSmartAccount({
        client: f.client,
        owners: [privateKeyToAccount(keyOf("coinbase owner"))],
        version: "1.1",
      });

    itFork("serves every canonical EntryPoint deployed on Base", async () => {
      expect(b.entryPoints).toEqual([
        entryPoint06Address,
        entryPoint07Address,
        entryPoint08Address,
        entryPoint09Address,
      ]);
      expect(await b.client.getSupportedEntryPoints()).toEqual(b.entryPoints);
      expect(await b.client.getChainId()).toBe(base.id);
    });

    itFork(
      "deploys a counterfactual Coinbase Smart Wallet in its first user operation",
      async () => {
        const account = await coinbaseAccount();
        expect(await f.client.getCode({ address: account.address })).toBeUndefined();
        await f.dealNative(account.address, parseEther("1"));

        await f.expectBalanceChange(NATIVE, recipient, 1_234n, async () => {
          const hash = await b.client.sendUserOperation({
            // viem's default nonce key is Date.now(): a new EntryPoint slot every run, which the
            // offline fork cache cannot replay. Key 0 reads the same slot every time.
            nonce: await account.getNonce({ key: 0n }),
            account,
            calls: [{ to: recipient, value: 1_234n }],
          });
          const receipt = await b.client.waitForUserOperationReceipt({ hash });
          expect(receipt.success).toBe(true);
          expect(getAddress(receipt.entryPoint)).toBe(entryPoint06Address);
          expect(getAddress(receipt.sender)).toBe(account.address);
        });
        expect(await f.client.getCode({ address: account.address })).toMatch(/^0x.+/);
      },
    );

    itFork("pays USDC from the smart account: balance and Transfer event land", async () => {
      const account = await coinbaseAccount();
      await f.dealNative(account.address, parseEther("1"));
      await f.deal(USDC, account.address, 10_000_000n);

      const receipt = await f.expectBalanceChange(USDC, recipient, 2_500_000n, async () => {
        const hash = await b.client.sendUserOperation({
          nonce: await account.getNonce({ key: 0n }),
          account,
          calls: [
            { to: USDC, abi: erc20Abi, functionName: "transfer", args: [recipient, 2_500_000n] },
          ],
        });
        return await b.client.waitForUserOperationReceipt({ hash });
      });
      expect(receipt.success).toBe(true);
      expectEmit(receipt.receipt, getAbiItem({ abi: erc20Abi, name: "Transfer" }), {
        from: account.address,
        to: recipient,
        value: 2_500_000n,
      });
    });

    itFork("EntryPoint v0.8: an EIP-7702 account sends a user operation", async () => {
      const owner = privateKeyToAccount(keyOf("7702 owner"));
      await f.dealNative(owner.address, parseEther("1"));
      const account = await toSimple7702SmartAccount({ client: f.client, owner });
      const authorization = await owner.signAuthorization({
        chainId: base.id,
        nonce: await f.client.getTransactionCount({ address: owner.address }),
        contractAddress: account.authorization.address,
      });

      await f.expectBalanceChange(NATIVE, recipient, 777n, async () => {
        const hash = await b.client.sendUserOperation({
          nonce: await account.getNonce({ key: 0n }),
          account,
          authorization,
          calls: [{ to: recipient, value: 777n }],
        });
        const receipt = await b.client.waitForUserOperationReceipt({ hash });
        expect(receipt.success).toBe(true);
        expect(getAddress(receipt.entryPoint)).toBe(entryPoint08Address);
      });
      // The EOA now delegates to the account implementation (EIP-7702 designator 0xef0100…).
      expect(await f.client.getCode({ address: owner.address })).toMatch(/^0xef0100/);
    });

    itFork("keeps bundling across repeated snapshot/revert rounds", async () => {
      // alto stalls on the second revert unless the chain moves on; the bundler URL mines a block
      // before each send. Three rounds of send-then-revert must all land.
      for (let round = 0; round < 3; round++) {
        const snapshot = await f.snapshot();
        const account = await coinbaseAccount();
        await f.dealNative(account.address, parseEther("1"));
        const hash = await b.client.sendUserOperation({
          nonce: await account.getNonce({ key: 0n }),
          account,
          calls: [{ to: recipient, value: BigInt(round + 1) }],
        });
        const receipt = await b.client.waitForUserOperationReceipt({ hash, timeout: 30_000 });
        expect(receipt.success).toBe(true);
        await f.revertTo(snapshot);
      }
    });
  },
);
