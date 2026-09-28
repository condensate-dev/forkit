import { Instance } from "prool";
import { freePort } from "../../src/index.ts";

/** A plain local anvil (chain id 31337) that the tests fork, so they need no network. */
export async function startUpstream(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const instance = Instance.anvil({ host: "127.0.0.1", port });
  await instance.start();
  return { url: `http://127.0.0.1:${port}`, stop: () => instance.stop() };
}
