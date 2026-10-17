/**
 * Builds `describeFork` / `itFork` for one test runner from its `describe`, `it` and hooks. Each
 * runner adapter (`@condensate/forkit/vitest`, `/bun`, `/jest`, `/node`) is this plus imports.
 */
import type { Chain } from "viem";
import { type ForkSuiteOptions, type ForkTargets, type SuiteHooks } from "./suite.ts";
import type { Fork } from "./types.ts";
type TestFn = () => Promise<void> | void;
/** A suite in the runner's tree, linked to its parent (vitest's shape). */
export interface SuiteNode {
    suite?: SuiteNode | undefined;
}
/** The parts of a test runner an adapter needs. */
export interface RunnerApi {
    describe(name: string, body: () => void): void;
    it(name: string, fn: TestFn, timeoutMs?: number): void;
    hooks: SuiteHooks;
    /**
     * The suite being collected (vitest). Optional: it only lets an `itFork` placed outside any
     * describeFork fail at collection time instead of when it runs.
     */
    currentSuite?(): SuiteNode | undefined;
}
export interface ForkAdapter {
    /**
     * A `describe` block with a fork: booted before the first test, every chain reverted to a clean
     * snapshot after every test, stopped after the last. `body` receives the fork handle. Pass an
     * array of targets for a multi-chain fork; the first chain is selected.
     */
    describeFork<TChain extends Chain>(name: string, targets: ForkTargets<TChain>, body: (fork: Fork<TChain>) => void, options?: ForkSuiteOptions): void;
    /**
     * A test inside {@link ForkAdapter.describeFork} (directly or in a nested `describe`) that
     * receives the nearest enclosing fork. Pass the chain
     * type (`itFork<typeof base>(...)`) for a typed client; the `describeFork` body's handle is
     * always precisely typed.
     */
    itFork<TChain extends Chain = Chain>(name: string, fn: (fork: Fork<TChain>) => Promise<void> | void, timeoutMs?: number): void;
}
export declare function createForkAdapter(runner: RunnerApi): ForkAdapter;
export {};
//# sourceMappingURL=adapter.d.ts.map