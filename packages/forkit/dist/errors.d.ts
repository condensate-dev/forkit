/** Base class for every error forkit throws. */
export declare class ForkitError extends Error {
    name: string;
}
/** Thrown by every API that a later milestone implements. */
export declare class NotImplementedError extends ForkitError {
    name: string;
    readonly api: string;
    readonly milestone: number;
    constructor(api: string, milestone: number);
}
/** anvil is not installed, or not on PATH. Thrown at collection time, never skipped. */
export declare class AnvilNotFoundError extends ForkitError {
    name: string;
    constructor(binary: string, cause?: unknown);
}
/** anvil failed to boot, or did not become ready in time. */
export declare class ForkBootError extends ForkitError {
    name: string;
}
/** A balance write did not produce the requested balance. */
export declare class DealError extends ForkitError {
    name: string;
}
/** A request an offline fork made that its recording has no answer for. */
export interface ForkCacheMiss {
    /** The recording, `<cacheDir>/<chainId>/<block>.json`. */
    readonly path: string;
    readonly method: string;
    readonly params: readonly unknown[];
    /** How many times it was asked: anvil and viem retry a request that failed. */
    readonly count: number;
}
/**
 * An offline fork (`cache: "offline"` or `FORKIT_CACHE=offline`) asked for state its recording
 * does not have. The request itself fails, and the fork's `stop()` (the end of a `describeFork`)
 * throws this with every miss, so the run fails even when the code under test caught the failed
 * request, or never saw it (anvil's own reads, a bundler's log queries).
 */
export declare class ForkCacheMissError extends ForkitError {
    name: string;
    readonly misses: readonly ForkCacheMiss[];
    constructor(misses: readonly ForkCacheMiss[]);
}
/**
 * An expectation (`expectRevert`, `expectEmit`, `expectBalanceChange`) did not hold. Carries
 * `actual` and `expected` so runners that understand them (vitest, mocha-style) print a diff.
 */
export declare class ForkitAssertionError extends ForkitError {
    name: string;
    readonly actual: unknown;
    readonly expected: unknown;
    readonly showDiff: boolean;
    constructor(message: string, details?: {
        actual?: unknown;
        expected?: unknown;
        cause?: unknown;
    });
}
//# sourceMappingURL=errors.d.ts.map