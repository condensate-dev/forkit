import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import type { Chain } from "viem";
import { AnvilNotFoundError } from "./errors.ts";

const checked = new Map<string, string>();

/**
 * Throw {@link AnvilNotFoundError} unless `anvil --version` runs. Synchronous so runner adapters can
 * call it while collecting tests, which turns a missing anvil into a collection error.
 * Returns the version line.
 */
export function assertAnvilInstalled(binary = "anvil"): string {
  const cached = checked.get(binary);
  if (cached !== undefined) return cached;
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw new AnvilNotFoundError(binary, result.error ?? result.stderr);
  }
  const version = result.stdout.split("\n")[0]?.trim() ?? "";
  checked.set(binary, version);
  return version;
}

/**
 * OP-stack chains need anvil's `--optimism`. viem marks them with a `gasPriceOracle` contract.
 */
export function isOpStack(chain: Chain): boolean {
  return chain.contracts?.gasPriceOracle !== undefined;
}

/** Ask the OS for a free TCP port on 127.0.0.1. */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("forkit: the OS returned no port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
