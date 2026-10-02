/**
 * @condensate_dev/forkit: Foundry-style fork tests in TypeScript.
 *
 * Runner adapters live in subpath exports (`@condensate_dev/forkit/vitest`, ...). APIs planned for a
 * later milestone throw {@link NotImplementedError} (see docs/spec.md, "Milestones").
 */

export { createForkAdapter, type ForkAdapter, type RunnerApi } from "./adapter.ts";
export { assertAnvilInstalled, freePort, isOpStack } from "./anvil.ts";
export {
  type ExpectEmitOptions,
  type ExpectedRevert,
  type ExpectRevertOptions,
  expectBalanceChange,
  expectEmit,
  expectRevert,
  NATIVE,
} from "./assertions.ts";
export { type ForkClient, type PrankClient, TRACE_PROPERTY, traceOf } from "./client.ts";
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
  type ForkCacheMiss,
  ForkCacheMissError,
  ForkitAssertionError,
  ForkitError,
  NotImplementedError,
} from "./errors.ts";
export {
  type BridgeFillEvent,
  type DealEvent,
  type ForkBootEvent,
  type ForkitEvent,
  type GasSnapshotEvent,
  type HttpEvent,
  observersSettled,
  onForkitEvent,
  type TestEndEvent,
  type TestStartEvent,
  type TxLog,
  type TxMinedEvent,
  type TxRevertedEvent,
  type TxSentEvent,
  trackObserverWork,
} from "./events.ts";
export { DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS, fork } from "./fork.ts";
export {
  DEFAULT_GAS_SNAPSHOT_FILE,
  formatGasSnapshot,
  GAS_SNAPSHOT_ENV,
  GAS_SNAPSHOT_FILE_ENV,
  type GasSnapshotMode,
  parseGasSnapshot,
} from "./gas.ts";
export {
  allLabels,
  clearLabels,
  formatAddress,
  label,
  labelOf,
  registerAbi,
} from "./labels.ts";
export { type DecodedRevert, decodeRevert, describeRevert, revertOf } from "./revert.ts";
export { type ResolvedRpc, type RpcSource, resolveForkUrl, rpcEnvVar } from "./rpc.ts";
export {
  CACHE_DIR_ENV,
  CACHE_MODE_ENV,
  type CacheMode,
  DEFAULT_CACHE_DIR,
  type RpcCacheStats,
} from "./rpc-cache.ts";
export {
  type AttachOptions,
  attachSharedFork,
  SHARED_FORKS_ENV,
  type SharedForks,
  startSharedForks,
} from "./shared.ts";
export {
  createForkSuite,
  type ForkSuiteOptions,
  type ForkTargets,
  type SuiteHooks,
} from "./suite.ts";
export { type CallFrame, formatTrace } from "./trace.ts";
export type { Fork, ForkOptions, ForkTarget, GasSource, SnapshotId } from "./types.ts";
