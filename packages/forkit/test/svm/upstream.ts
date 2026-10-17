/**
 * A local, offline surfnet that the tests fork from instead of a public RPC: a real surfpool on
 * both sides, and no network. Accounts the tests need on "mainnet" are seeded on it first.
 */
import { address, lamports } from "@solana/kit";
import { type Surfnet, surfnet } from "../../src/svm/index.ts";

/** A wallet that only exists on the upstream until a fork reads it. */
export const SEEDED = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
export const SEEDED_LAMPORTS = lamports(5_000_000_000n);

/** Poll until `check` passes: surfpool lands an airdrop on its next slot. */
export async function eventually(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function startUpstream(): Promise<Surfnet> {
  const upstream = await surfnet({ offline: true });
  await upstream.rpc.requestAirdrop(SEEDED, SEEDED_LAMPORTS).send();
  await eventually(
    async () => (await upstream.rpc.getBalance(SEEDED).send()).value === SEEDED_LAMPORTS,
  );
  return upstream;
}
