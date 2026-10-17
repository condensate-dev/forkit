/**
 * @condensate/forkit/svm: fork Solana with surfpool, from any test runner.
 *
 * `surfnet()` boots a headless surfnet forked from an RPC; accounts load from it on demand. Runner
 * adapters live in `@condensate/forkit/svm/vitest` and `/svm/bun`.
 */
export { ForkitError } from "../errors.ts";
export { createSurfnetAdapter, type SurfnetAdapter } from "./adapter.ts";
export { SurfnetBootError, SurfnetRpcError, SurfpoolNotFoundError } from "./errors.ts";
export { jsonRpc } from "./rpc.ts";
export { createSurfnetSuite, type SuiteHooks } from "./suite.ts";
export { DEFAULT_SURFNET_BOOT_TIMEOUT_MS, DEFAULT_SURFNET_STOP_TIMEOUT_MS, DEFAULT_SVM_RPC_URL, resolveSurfnetSource, type Surfnet, type SurfnetInfo, type SurfnetOptions, type SurfnetStartupStatus, surfnet, surfpoolArgs, } from "./surfnet.ts";
export { assertSurfpoolInstalled, parseSurfpoolVersion, resolveSurfpoolBinary, SURFPOOL_VERSION, } from "./surfpool.ts";
//# sourceMappingURL=index.d.ts.map