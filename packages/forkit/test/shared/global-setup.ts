import { foundry } from "viem/chains";
import { startSharedForks } from "../../src/index.ts";
import { startUpstream } from "../anvil/upstream.ts";

/** Boots one local upstream and one shared fork of it for every file in the `shared` project. */
export default async function setup() {
  const upstream = await startUpstream();
  const shared = await startSharedForks({
    chain: foundry,
    forkUrl: upstream.url,
    blockNumber: 0n,
    cache: "off",
  });
  process.env.FORKIT_TEST_SHARED_URL = shared.fork.rpcUrl;
  return async () => {
    await shared.stop();
    await upstream.stop();
  };
}
