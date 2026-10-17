/**
 * @condensate/forkit/svm: fork Solana with surfpool, from any test runner.
 *
 * `surfnet()` boots a headless surfnet forked from an RPC; accounts load from it on demand. Runner
 * adapters live in `@condensate/forkit/svm/vitest` and `/svm/bun`.
 */
export { DealError, ForkitError } from "../errors.js";
export { createSurfnetAdapter } from "./adapter.js";
export { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, associatedTokenAddress, BPF_LOADER_UPGRADEABLE_ADDRESS, decodeClock, programDataAddress, SYSVAR_CLOCK_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, } from "./cheats.js";
export { SurfnetBootError, SurfnetRpcError, SurfpoolNotFoundError } from "./errors.js";
export { jsonRpc, stringifyWithBigints } from "./rpc.js";
export { createSurfnetSuite } from "./suite.js";
export { DEFAULT_SURFNET_BOOT_TIMEOUT_MS, DEFAULT_SURFNET_STOP_TIMEOUT_MS, DEFAULT_SVM_RPC_URL, resolveSurfnetSource, surfnet, surfpoolArgs, } from "./surfnet.js";
export { assertSurfpoolInstalled, parseSurfpoolVersion, resolveSurfpoolBinary, SURFPOOL_VERSION, } from "./surfpool.js";
//# sourceMappingURL=index.js.map