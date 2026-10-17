import { Instance } from "prool";
import type { Chain } from "viem";
import { type GasSnapshotSettings } from "./gas.ts";
import type { Fork, ForkOptions, ForkTarget, SnapshotId } from "./types.ts";
export declare const DEFAULT_BOOT_TIMEOUT_MS = 120000;
export declare const DEFAULT_STOP_TIMEOUT_MS = 10000;
export declare function toForkOptions<TChain extends Chain>(target: ForkTarget<TChain>): ForkOptions<TChain>;
/**
 * The anvil flags forkit passes. Exported for tests. `viaCache` means `url` is forkit's local
 * recording proxy: then anvil's own disk cache is off (it would hide requests from the
 * recording) and so is its rate limiter (the proxy is local).
 */
export declare function anvilParameters(options: ForkOptions, url: string, port: number, viaCache?: boolean): Instance.anvil.Parameters;
/** The per-handle settings that come from options and env; each throws on a bad value. */
export interface HandleSettings {
    traces: boolean;
    gas: GasSnapshotSettings;
    warn: (message: string) => void;
}
/**
 * Resolve a fork's options into handle settings. Called before anything boots or is leased, so a
 * bad option throws with nothing left running or held.
 */
export declare function resolveHandleSettings(options: ForkOptions): HandleSettings;
/** `traces` option, then `FORKIT_TRACES`, then `on-failure`. */
export declare function resolveTraces(option: ForkOptions["traces"], env?: Readonly<Record<string, string | undefined>>): boolean;
/** A running anvil to attach to (see `attachSharedFork`). */
export interface AttachTarget<TChain extends Chain = Chain> {
    options: ForkOptions<TChain>;
    rpcUrl: string;
}
/**
 * Handles on anvils forkit did not start. `stop()` on any of them calls `release` once and never
 * kills the process.
 */
export declare function attachForks(targets: readonly AttachTarget[], release: () => Promise<void>): Promise<Fork>;
/**
 * Boot an anvil fork of one chain, or of several chains for cross-chain tests.
 *
 * With several targets, every chain boots in parallel on its own anvil and port. The handle
 * selects the first chain; `on(chain)` selects another, and `stop()` on any of them stops all.
 * If one chain fails to boot, the others are stopped before the error is thrown.
 */
export declare function fork<TChain extends Chain>(target: ForkTarget<TChain>): Promise<Fork<TChain>>;
export declare function fork<TChain extends Chain>(targets: readonly [ForkTarget<TChain>, ...ForkTarget[]]): Promise<Fork<TChain>>;
/** Snapshot every test's starting state without recording a cheat (see `describeFork`). */
export declare const isolationSnapshot: (fork: Fork) => Promise<SnapshotId>;
/** Revert to a test's starting state without recording a cheat. */
export declare const isolationRevert: (fork: Fork, id: SnapshotId) => Promise<void>;
//# sourceMappingURL=fork.d.ts.map