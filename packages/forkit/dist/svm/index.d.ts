/**
 * @condensate/forkit/svm: fork Solana with surfpool, from any test runner.
 *
 * `surfnet()` boots a headless surfnet forked from an RPC; accounts load from it on demand. Runner
 * adapters live in `@condensate/forkit/svm/vitest` and `/svm/bun`.
 */
export { DealError, ForkitError } from "../errors.ts";
export { createSurfnetAdapter, type SurfnetAdapter } from "./adapter.ts";
export { type AccountPatch, ASSOCIATED_TOKEN_PROGRAM_ADDRESS, associatedTokenAddress, BPF_LOADER_UPGRADEABLE_ADDRESS, type DealTokenOptions, decodeClock, type EtchOptions, programDataAddress, type ResetOptions, type SurfnetCheats, type SurfnetClock, type SurfnetEpochInfo, SYSVAR_CLOCK_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, type WarpTarget, } from "./cheats.ts";
export { SurfnetBootError, SurfnetRpcError, SurfpoolNotFoundError } from "./errors.ts";
export { jsonRpc, stringifyWithBigints } from "./rpc.ts";
export { createSurfnetSuite, type SuiteHooks, type SurfnetSuiteOptions } from "./suite.ts";
export { DEFAULT_SURFNET_BOOT_TIMEOUT_MS, DEFAULT_SURFNET_STOP_TIMEOUT_MS, DEFAULT_SVM_RPC_URL, resolveSurfnetSource, type Surfnet, type SurfnetBase, type SurfnetInfo, type SurfnetOptions, type SurfnetStartupStatus, surfnet, surfpoolArgs, } from "./surfnet.ts";
export { assertSurfpoolInstalled, parseSurfpoolVersion, resolveSurfpoolBinary, SURFPOOL_VERSION, } from "./surfpool.ts";
//# sourceMappingURL=index.d.ts.map