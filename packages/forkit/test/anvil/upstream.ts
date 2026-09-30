import { Instance } from "prool";
import { defineChain } from "viem";
import { freePort } from "../../src/index.ts";

/** A second local chain for multi-chain tests. */
export const otherChain = defineChain({
  id: 31_338,
  name: "Other",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8546"] } },
});

/**
 * A plain local anvil (chain id 31337 by default) that the tests fork, so they need no network.
 * It logs every request to a stdout that only this process's event loop drains: while forks use
 * it, never block that loop (no spawnSync), or anvil stalls on a full stdout and stops answering.
 */
export async function startUpstream(
  chainId?: number,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const instance = Instance.anvil({
    host: "127.0.0.1",
    port,
    ...(chainId === undefined ? {} : { chainId }),
  });
  await instance.start();
  return { url: `http://127.0.0.1:${port}`, stop: () => instance.stop() };
}
