import type { Chain } from "viem";
/**
 * Throw {@link AnvilNotFoundError} unless `anvil --version` runs. Synchronous so runner adapters can
 * call it while collecting tests, which turns a missing anvil into a collection error.
 * Returns the version line.
 */
export declare function assertAnvilInstalled(binary?: string): string;
/**
 * OP-stack chains need anvil's `--optimism`. viem marks them with a `gasPriceOracle` contract.
 */
export declare function isOpStack(chain: Chain): boolean;
/** Ask the OS for a free TCP port on 127.0.0.1. */
export declare function freePort(): Promise<number>;
//# sourceMappingURL=anvil.d.ts.map