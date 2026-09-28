/**
 * @condensate/forkit: Foundry-style fork tests in TypeScript.
 *
 * Runner adapters live in subpath exports (`@condensate/forkit/vitest`, ...). APIs planned for a
 * later milestone throw {@link NotImplementedError} (see docs/spec.md, "Milestones").
 */

export { createForkAdapter, type ForkAdapter, type RunnerApi } from "./adapter.ts";
export { assertAnvilInstalled, freePort, isOpStack } from "./anvil.ts";
export { expectBalanceChange, expectEmit, expectRevert } from "./assertions.ts";
export type { ForkClient, PrankClient } from "./client.ts";
export {
  type DealOptions,
  type DealStrategy,
  erc20BalanceAbi,
  findBalanceSlot,
} from "./deal.ts";
export {
  AnvilNotFoundError,
  DealError,
  ForkBootError,
  ForkitError,
  NotImplementedError,
} from "./errors.ts";
export { DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS, fork } from "./fork.ts";
export { type ResolvedRpc, type RpcSource, resolveForkUrl, rpcEnvVar } from "./rpc.ts";
export {
  CACHE_DIR_ENV,
  CACHE_MODE_ENV,
  type CacheMode,
  DEFAULT_CACHE_DIR,
  type RpcCacheStats,
} from "./rpc-cache.ts";
export {
  createForkSuite,
  type ForkSuiteOptions,
  type ForkTargets,
  type SuiteHooks,
} from "./suite.ts";
export type { Fork, ForkOptions, ForkTarget, SnapshotId } from "./types.ts";
