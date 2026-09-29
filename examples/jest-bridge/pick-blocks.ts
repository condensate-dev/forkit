/**
 * Picks a fresh pair of pins for test/bridge.test.ts: a Base block about a minute old, and the
 * first Arbitrum block at least 20 s after it. Arbitrum's public RPC only serves recent state,
 * so run this, paste the output into the test, and record straight away (see README.md).
 *
 *   node pick-blocks.ts
 */
import { createPublicClient, http } from "viem";
import { arbitrum, base } from "viem/chains";

const baseClient = createPublicClient({ chain: base, transport: http() });
const arbClient = createPublicClient({ chain: arbitrum, transport: http() });

const baseBlock = await baseClient.getBlock({
  blockNumber: (await baseClient.getBlockNumber()) - 30n, // Base makes a block every 2 s
});
const target = baseBlock.timestamp + 20n;

// Binary search for the first Arbitrum block at or after `target` (Arbitrum: ~4 blocks a second).
let hi = await arbClient.getBlockNumber();
let lo = hi - 2_000n;
while (lo < hi) {
  const mid = (lo + hi) / 2n;
  if ((await arbClient.getBlock({ blockNumber: mid })).timestamp < target) lo = mid + 1n;
  else hi = mid;
}
const arbBlock = await arbClient.getBlock({ blockNumber: lo });

const underscores = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
console.log(`const BASE_BLOCK = ${underscores(baseBlock.number)}n;
const BASE_TIMESTAMP = ${underscores(baseBlock.timestamp)}; // of BASE_BLOCK
const ARB_BLOCK = ${underscores(arbBlock.number)}n;
const ARB_TIMESTAMP = ${underscores(arbBlock.timestamp)}; // of ARB_BLOCK, ${arbBlock.timestamp - baseBlock.timestamp} s later`);
