/**
 * @condensate/forkit/svm: fork Solana with surfpool, from any test runner.
 *
 * `surfnet()` boots a headless surfnet forked from an RPC; accounts load from it on demand. Runner
 * adapters live in `@condensate/forkit/svm/vitest` and `/svm/bun`.
 */
export { ForkitError } from "../errors.js";
export { createSurfnetAdapter } from "./adapter.js";
export { SurfnetBootError, SurfnetRpcError, SurfpoolNotFoundError } from "./errors.js";
export { jsonRpc } from "./rpc.js";
export { createSurfnetSuite } from "./suite.js";
export { DEFAULT_SURFNET_BOOT_TIMEOUT_MS, DEFAULT_SURFNET_STOP_TIMEOUT_MS, DEFAULT_SVM_RPC_URL, resolveSurfnetSource, surfnet, surfpoolArgs, } from "./surfnet.js";
export { assertSurfpoolInstalled, parseSurfpoolVersion, resolveSurfpoolBinary, SURFPOOL_VERSION, } from "./surfpool.js";
//# sourceMappingURL=index.js.map