/**
 * One small fork scenario for the bun and node:test reporter fixtures: bob gets paid in coins,
 * then a withdrawal reverts with a custom error (a deliberate failure).
 */
import { type Address, parseEther, parseUnits } from "viem";
import { foundry } from "viem/chains";
import { type ForkAdapter, label } from "../../../src/index.ts";
import { COIN_BYTECODE, coinAbi } from "../../fixtures/coin.ts";
import { VAULT_BYTECODE, vaultAbi } from "../../fixtures/vault.ts";

const alice: Address = "0x00000000000000000000000000000000000a11ce";
const bob: Address = "0x0000000000000000000000000000000000000b0b";

export function scenario(
  { describeFork, itFork }: ForkAdapter,
  forkUrl: string,
  beforeAll: (fn: () => Promise<void>) => void,
): void {
  describeFork("coin", { chain: foundry, forkUrl, blockNumber: 0n, cache: "off" }, (f) => {
    let deployer: Address;
    let coin: Address;
    let vault: Address;
    beforeAll(async () => {
      [deployer] = (await f.client.getAddresses()) as [Address];
      const coinHash = await f.client.deployContract({
        abi: coinAbi,
        bytecode: COIN_BYTECODE,
        args: [parseUnits("1000000", 6)],
        account: deployer,
      });
      coin = (await f.client.waitForTransactionReceipt({ hash: coinHash }))
        .contractAddress as Address;
      const vaultHash = await f.client.deployContract({
        abi: vaultAbi,
        bytecode: VAULT_BYTECODE,
        account: deployer,
      });
      vault = (await f.client.waitForTransactionReceipt({ hash: vaultHash }))
        .contractAddress as Address;
      label(alice, "alice");
      label(bob, "bob");
      label(deployer, "deployer");
      label(vault, "Vault");
    });

    itFork("pays bob in coins", async () => {
      await f.client.writeContract({
        account: deployer,
        address: coin,
        abi: coinAbi,
        functionName: "transfer",
        args: [bob, parseUnits("42.25", 6)],
      });
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
  });
}
