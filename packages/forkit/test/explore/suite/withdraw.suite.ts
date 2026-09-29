import { type Address, parseEther } from "viem";
import { beforeAll, expect } from "vitest";
import { describeFork, itFork } from "../../../src/vitest.ts";
import { vaultAbi } from "../../fixtures/vault.ts";
import { alice, bob, deployVault, target } from "./shared.ts";

describeFork("Vault withdrawals", target, (f) => {
  let vault: Address;
  beforeAll(async () => {
    vault = await deployVault(f);
  });

  itFork("alice withdraws to bob", async () => {
    await f.dealNative(alice, parseEther("5"));
    await f.prank(alice, async (c) => {
      await c.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "deposit",
        value: parseEther("2"),
      });
      await c.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "withdraw",
        args: [bob, parseEther("1")],
      });
    });
    expect(await f.client.getBalance({ address: bob })).toBe(parseEther("1"));
  });

  itFork("fails on purpose, so the record has a failure", async () => {
    expect(await f.client.getBalance({ address: bob }), "bob starts empty").toBe(1n);
  });
});
