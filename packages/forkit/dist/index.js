/**
 * @condensate/forkit: Foundry-style fork tests in TypeScript.
 *
 * Runner adapters live in subpath exports (`@condensate/forkit/vitest`, ...). APIs planned for a
 * later milestone throw {@link NotImplementedError} (see docs/spec.md, "Milestones").
 */
export { createForkAdapter } from "./adapter.js";
export { assertAnvilInstalled, freePort, isOpStack } from "./anvil.js";
export { expectBalanceChange, expectEmit, expectRevert, NATIVE, } from "./assertions.js";
export { TRACE_PROPERTY, traceOf } from "./client.js";
export { erc20BalanceAbi, findBalanceSlot, } from "./deal.js";
export { AnvilNotFoundError, DealError, ForkBootError, ForkCacheMissError, ForkitAssertionError, ForkitError, NotImplementedError, } from "./errors.js";
export { observersSettled, onForkitEvent, trackObserverWork, } from "./events.js";
export { DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS, fork } from "./fork.js";
export { DEFAULT_GAS_SNAPSHOT_FILE, formatGasSnapshot, GAS_SNAPSHOT_ENV, GAS_SNAPSHOT_FILE_ENV, parseGasSnapshot, } from "./gas.js";
export { allLabels, clearLabels, formatAddress, label, labelOf, registerAbi, } from "./labels.js";
export { decodeRevert, describeRevert, revertOf } from "./revert.js";
export { resolveForkUrl, rpcEnvVar } from "./rpc.js";
export { CACHE_DIR_ENV, CACHE_MODE_ENV, DEFAULT_CACHE_DIR, } from "./rpc-cache.js";
export { attachSharedFork, SHARED_FORKS_ENV, startSharedForks, } from "./shared.js";
export { createForkSuite, } from "./suite.js";
export { formatTrace } from "./trace.js";
//# sourceMappingURL=index.js.map