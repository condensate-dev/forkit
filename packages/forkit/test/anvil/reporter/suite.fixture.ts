/**
 * A small fork suite run through the vitest reporter by `../reporter.vitest.ts`, in a child
 * vitest. Two of its tests fail on purpose, to show failure traces and diffs.
 */
import { type Address, getAbiItem, parseEther, parseUnits } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll } from "vitest";
import { bridge } from "../../../src/bridges/index.ts";
import { expectRevert, label } from "../../../src/index.ts";
import { describeFork, itFork } from "../../../src/vitest.ts";
import { COIN_BYTECODE, coinAbi } from "../../fixtures/coin.ts";
import { VAULT_BYTECODE, vaultAbi } from "../../fixtures/vault.ts";
import { startUpstreams } from "../adapter-contract.ts";
import { otherChain } from "../upstream.ts";

const alice: Address = "0x00000000000000000000000000000000000a11ce";
const bob: Address = "0x0000000000000000000000000000000000000b0b";
const escrow: Address = "0x00000000000000000000000000000000000e5c20";
const coins = (amount: string) => parseUnits(amount, 6);

const upstreams = await startUpstreams();
afterAll(() => upstreams.stop());

describeFork(
  "coin",
  [
    { chain: foundry, forkUrl: upstreams.a.url, blockNumber: 0n, cache: "off" },
    { chain: otherChain, forkUrl: upstreams.b.url, blockNumber: 0n, cache: "off" },
  ],
  (f) => {
    const other = f.on(otherChain);
    let deployer: Address;
    let coin: Address;
    let otherCoin: Address;
    let vault: Address;

    const deploy = async (g: typeof f | typeof other, abi: typeof coinAbi | typeof vaultAbi) => {
      const hash =
        abi === coinAbi
          ? await g.client.deployContract({
              abi: coinAbi,
              bytecode: COIN_BYTECODE,
              args: [coins("1000000")],
              account: deployer,
            })
          : await g.client.deployContract({
              abi: vaultAbi,
              bytecode: VAULT_BYTECODE,
              account: deployer,
            });
      return (await g.client.waitForTransactionReceipt({ hash })).contractAddress as Address;
    };

    beforeAll(async () => {
      [deployer] = (await f.client.getAddresses()) as [Address];
      coin = await deploy(f, coinAbi);
      vault = await deploy(f, vaultAbi);
      otherCoin = await deploy(other, coinAbi);
      label(alice, "alice");
      label(bob, "bob");
      label(escrow, "escrow");
      label(deployer, "deployer");
      // The coins stay unlabelled: the reporter names them by their symbol() (TCOIN).
      label(vault, "Vault");
    });

    // After the last test: its events reach the reporter through the file's own meta.
    afterAll(async () => {
      await f.client.writeContract({
        account: deployer,
        address: coin,
        abi: coinAbi,
        functionName: "transfer",
        args: [escrow, coins("1")],
      });
    });

    itFork("pays bob in coins and ether", async () => {
      await f.dealNative(alice, parseEther("5"));
      await f.client.writeContract({
        account: deployer,
        address: coin,
        abi: coinAbi,
        functionName: "transfer",
        args: [alice, coins("1000")],
      });
      await f.gasSnapshot("coin transfer", () =>
        f.prank(alice, (c) =>
          c.writeContract({
            address: coin,
            abi: coinAbi,
            functionName: "transfer",
            args: [bob, coins("250.5")],
          }),
        ),
      );
      await f.prank(alice, (c) => c.sendTransaction({ to: bob, value: parseEther("1") }));
    });

    itFork("bridges coins to Other", async () => {
      const toy = bridge.custom(f, {
        name: "toy",
        originEvent: {
          event: getAbiItem({ abi: coinAbi, name: "Transfer" }),
          address: { [foundry.id]: coin },
        },
        destinationOf: () => otherChain.id,
        onDeposit: async ({ deposit, destination }) => {
          const { from, value } = deposit.args as { from: Address; value: bigint };
          const fee = coins("0.5");
          const hash = await destination.client.writeContract({
            account: deployer,
            address: otherCoin,
            abi: coinAbi,
            functionName: "transfer",
            args: [from, value - fee],
          });
          return { txHashes: [hash], outputAmount: value - fee, details: { fee } };
        },
      });
      await f.client.writeContract({
        account: deployer,
        address: coin,
        abi: coinAbi,
        functionName: "transfer",
        args: [escrow, coins("100")],
      });
      await toy.settle();
    });

    itFork("rejects a zero deposit with the right reason", async () => {
      await f.dealNative(alice, parseEther("1"));
      await expectRevert(
        f.prank(alice, (c) =>
          c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value: 0n }),
        ),
        "Vault: nothing to deposit",
      );
    });

    itFork("withdraws more than it holds", async () => {
      await f.dealNative(alice, parseEther("1"));
      await f.prank(alice, (c) =>
        c.writeContract({
          address: vault,
          abi: vaultAbi,
          functionName: "withdraw",
          args: [alice, parseEther("2")],
        }),
      );
    });
  },
);
