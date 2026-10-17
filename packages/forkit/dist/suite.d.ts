import type { Chain } from "viem";
import { type AttachOptions } from "./shared.ts";
import type { Fork, ForkTarget } from "./types.ts";
type Hook = () => Promise<void> | void;
type RegisterHook = (fn: Hook, timeoutMs?: number) => void;
/** The lifecycle hooks of whichever test runner an adapter wraps. */
export interface SuiteHooks {
    beforeAll: RegisterHook;
    afterAll: RegisterHook;
    beforeEach: RegisterHook;
    afterEach: RegisterHook;
}
export interface ForkSuiteOptions {
    /**
     * Snapshot every chain before each test and revert after it (default `true`). Tests in one
     * suite share a fork, so isolation assumes they run one at a time: do not use
     * `describe.concurrent` / `test.concurrent` inside a fork suite.
     */
    isolate?: boolean;
    /**
     * Attach to the forks a global setup started with `startSharedForks()` instead of booting
     * new ones. Files take turns on a shared fork (an exclusive lease), and each file leaves it
     * as it found it.
     */
    shared?: boolean | AttachOptions;
}
/** One chain, or several for a multi-chain fork (the first is selected). */
export type ForkTargets<TChain extends Chain = Chain> = ForkTarget<TChain> | readonly [ForkTarget<TChain>, ...ForkTarget[]];
/**
 * Runner-agnostic fork lifecycle: boot once per suite, snapshot/revert every chain around every
 * test, stop at the end. Call it while tests are being collected: a missing anvil throws right
 * here, so the suite fails loudly instead of skipping.
 */
export declare function createForkSuite<TChain extends Chain>(targets: ForkTargets<TChain>, hooks: SuiteHooks, options?: ForkSuiteOptions): Fork<TChain>;
export {};
//# sourceMappingURL=suite.d.ts.map