/** Base class for every error forkit throws. */
export class ForkitError extends Error {
    name = "ForkitError";
}
/** Thrown by every API that a later milestone implements. */
export class NotImplementedError extends ForkitError {
    name = "NotImplementedError";
    api;
    milestone;
    constructor(api, milestone) {
        super(`forkit: ${api} is not implemented yet (planned for milestone ${milestone})`);
        this.api = api;
        this.milestone = milestone;
    }
}
/** anvil is not installed, or not on PATH. Thrown at collection time, never skipped. */
export class AnvilNotFoundError extends ForkitError {
    name = "AnvilNotFoundError";
    constructor(binary, cause) {
        super([
            `forkit: could not run \`${binary} --version\`. forkit needs foundry's anvil on PATH.`,
            "Install it with:",
            "  curl -L https://foundry.paradigm.xyz | bash && foundryup",
            "A fork suite that cannot run is a broken environment, not a skipped test.",
        ].join("\n"), { cause });
    }
}
/** anvil failed to boot, or did not become ready in time. */
export class ForkBootError extends ForkitError {
    name = "ForkBootError";
}
/** A balance write did not produce the requested balance. */
export class DealError extends ForkitError {
    name = "DealError";
}
/** How many misses the message lists, and how long each one's params may get. */
const LISTED_MISSES = 20;
const PARAMS_CHARS = 1_000;
function describeMisses(misses) {
    const lines = [
        `forkit: ${misses.length} request(s) missed the offline fork cache, so the fork could not answer them. Record them: run once with network access and FORKIT_CACHE=readwrite (the default).`,
    ];
    let path;
    for (const miss of misses.slice(0, LISTED_MISSES)) {
        if (miss.path !== path) {
            path = miss.path;
            lines.push(`  ${path}`);
        }
        const params = JSON.stringify(miss.params);
        const shown = params.length > PARAMS_CHARS ? `${params.slice(0, PARAMS_CHARS - 1)}…` : params;
        lines.push(`    ${miss.method} ${shown}${miss.count > 1 ? ` (×${miss.count})` : ""}`);
    }
    if (misses.length > LISTED_MISSES) {
        lines.push(`  … and ${misses.length - LISTED_MISSES} more (FORKIT_DEBUG=1 logs every miss)`);
    }
    return lines.join("\n");
}
/**
 * An offline fork (`cache: "offline"` or `FORKIT_CACHE=offline`) asked for state its recording
 * does not have. The request itself fails, and the fork's `stop()` (the end of a `describeFork`)
 * throws this with every miss, so the run fails even when the code under test caught the failed
 * request, or never saw it (anvil's own reads, a bundler's log queries).
 */
export class ForkCacheMissError extends ForkitError {
    name = "ForkCacheMissError";
    misses;
    constructor(misses) {
        super(describeMisses(misses));
        this.misses = misses;
    }
}
/**
 * An expectation (`expectRevert`, `expectEmit`, `expectBalanceChange`) did not hold. Carries
 * `actual` and `expected` so runners that understand them (vitest, mocha-style) print a diff.
 */
export class ForkitAssertionError extends ForkitError {
    name = "ForkitAssertionError";
    actual;
    expected;
    showDiff;
    constructor(message, details = {}) {
        super(message, details.cause === undefined ? undefined : { cause: details.cause });
        this.actual = details.actual;
        this.expected = details.expected;
        this.showDiff = "actual" in details && "expected" in details;
    }
}
//# sourceMappingURL=errors.js.map