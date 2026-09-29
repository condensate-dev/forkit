import { type Address, parseEther } from "viem";
import { beforeAll, expect } from "vitest";
import { expectRevert } from "../../../src/index.ts";
import { describeFork, itFork } from "../../../src/vitest.ts";
import { vaultAbi } from "../../fixtures/vault.ts";
import { alice, deployVault, target } from "./shared.ts";

describeFork("Vault deposits", target, (f) => {
  let vault: Address;
  beforeAll(async () => {
    vault = await deployVault(f);
  });

  itFork("alice deposits 1 ether", async () => {
    await f.dealNative(alice, parseEther("5"));
    await f.prank(alice, (c) =>
      c.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "deposit",
        value: parseEther("1"),
      }),
    );
    expect(
      await f.client.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [alice],
      }),
    ).toBe(parseEther("1"));
  });

  itFork("a zero deposit reverts before it is mined", async () => {
    await f.dealNative(alice, parseEther("5"));
    await expectRevert(
      f.prank(alice, (c) =>
        c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value: 0n }),
      ),
      "Vault: zero deposit",
    );
  });

  itFork("a zero deposit with explicit gas is mined, reverted", async () => {
    await f.dealNative(alice, parseEther("5"));
    const hash = await f.prank(alice, (c) =>
      c.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "deposit",
        value: 0n,
        gas: 200_000n,
      }),
    );
    expect((await f.client.waitForTransactionReceipt({ hash })).status).toBe("reverted");
  });
});
