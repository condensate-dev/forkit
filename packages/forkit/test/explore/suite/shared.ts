import type { Address } from "viem";
import { foundry } from "viem/chains";
import { type Fork, registerAbi } from "../../../src/index.ts";
import { ledgerAbi, VAULT_BYTECODE, vaultAbi } from "../../fixtures/vault.ts";

export const alice: Address = "0x00000000000000000000000000000000000a11ce";
export const bob: Address = "0x0000000000000000000000000000000000000b0b";

/** The upstream anvil the parent test started. */
export const target = {
  chain: foundry,
  forkUrl: process.env.EXPLORE_SUITE_UPSTREAM as string,
  blockNumber: 0n,
  cache: "off",
} as const;

export async function deployVault(f: Fork<typeof foundry>): Promise<Address> {
  const [deployer] = await f.client.getAddresses();
  const hash = await f.client.deployContract({
    abi: vaultAbi,
    bytecode: VAULT_BYTECODE,
    account: deployer as Address,
  });
  const receipt = await f.client.waitForTransactionReceipt({ hash });
  // The Vault deploys a Ledger; its ABI lets traces decode Vault → Ledger calls.
  registerAbi(ledgerAbi);
  f.label(receipt.contractAddress as Address, "Vault");
  f.label(alice, "alice");
  f.label(bob, "bob");
  return receipt.contractAddress as Address;
}
