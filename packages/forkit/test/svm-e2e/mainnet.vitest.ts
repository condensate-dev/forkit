/**
 * Forks Solana mainnet-beta for real: FORKIT_SVM_RPC_URL, else the public RPC. Runs in CI, which
 * has network; it reads only long-lived, public program and mint accounts.
 */
import { address } from "@solana/kit";
import { expect } from "vitest";
import { describeSurfnet, itSurfnet } from "../../src/svm/vitest.ts";

const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const WRAPPED_SOL_MINT = address("So11111111111111111111111111111111111111112");

describeSurfnet("mainnet-beta fork", {}, () => {
  itSurfnet("loads the SPL Token program from mainnet on demand", async (s) => {
    const { value } = await s.rpc.getAccountInfo(TOKEN_PROGRAM, { encoding: "base64" }).send();
    expect(value?.executable).toBe(true);
  });

  itSurfnet("loads a mint owned by the Token program", async (s) => {
    const { value } = await s.rpc.getAccountInfo(WRAPPED_SOL_MINT, { encoding: "base64" }).send();
    expect(value?.owner).toBe(TOKEN_PROGRAM);
  });

  itSurfnet("deals SOL and wrapped SOL to a fresh wallet", async (s) => {
    const wallet = address("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
    await s.dealSol(wallet, 3_000_000_000n);
    const ata = await s.deal(WRAPPED_SOL_MINT, wallet, 2_000_000_000n);
    const { value } = await s.rpc.getTokenAccountBalance(ata).send();
    expect(value.amount).toBe("2000000000");
    expect(value.decimals).toBe(9);
  });

  itSurfnet("warps the mainnet clock a day forward", async (s) => {
    const before = await s.clock();
    const after = await s.warp(86_400);
    expect(after.unixTimestamp).toBeGreaterThanOrEqual(before.unixTimestamp + 86_400n);
  });
});
