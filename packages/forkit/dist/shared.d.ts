import type { Chain } from "viem";
import type { Fork, ForkTarget } from "./types.ts";
/** Env var through which the global setup tells test workers where the shared forks are. */
export declare const SHARED_FORKS_ENV = "FORKIT_SHARED_FORKS";
export interface SharedForks {
    /** The env entry workers need; already set on `process.env`. */
    readonly env: Readonly<Record<string, string>>;
    /** The fork handle (for the global setup's own use). */
    readonly fork: Fork;
    /** Stop the forks and clean up. Return this from a vitest globalSetup, or call it in teardown. */
    stop(): Promise<void>;
}
type Targets = ForkTarget | readonly [ForkTarget, ...ForkTarget[]];
/**
 * Boot forks for every test file to share. Call it from a global setup (vitest `globalSetup`,
 * jest `globalSetup`, a bun preload); workers started afterwards inherit the env entry and
 * attach with `describeFork(..., { shared: true })` or {@link attachSharedFork}.
 */
export declare function startSharedForks(targets: Targets): Promise<SharedForks>;
export interface AttachOptions {
    /** How long to wait for other files to hand the shared fork over. Default 10 minutes. */
    leaseTimeoutMs?: number;
    /** Where to read the shared state from. Default `process.env`. */
    env?: Readonly<Record<string, string | undefined>>;
}
export declare const DEFAULT_LEASE_TIMEOUT_MS = 600000;
/**
 * Attach to the shared forks for these chains, waiting for the lease. The handle behaves like
 * a booted fork, except that `stop()` reverts every chain to the state found at attach time and
 * hands the lease on; the anvil keeps running for the next file.
 */
export declare function attachSharedFork<TChain extends Chain>(targets: ForkTarget<TChain> | readonly [ForkTarget<TChain>, ...ForkTarget[]], options?: AttachOptions): Promise<Fork<TChain>>;
export {};
//# sourceMappingURL=shared.d.ts.map