/**
 * The surfpool release forkit/svm is built and tested against. Its RPC method names come from
 * that tag's source (crates/core/src/rpc). CI installs exactly this release
 * (scripts/install-surfpool.sh); older releases are refused, newer ones are allowed.
 */
export declare const SURFPOOL_VERSION = "1.6.1";
/** The surfpool binary: the option, else `FORKIT_SURFPOOL_BIN`, else `surfpool` on PATH. */
export declare function resolveSurfpoolBinary(option?: string, env?: Readonly<Record<string, string | undefined>>): string;
/** `[major, minor, patch]` from a version string such as `surfpool 1.6.1`, or `undefined`. */
export declare function parseSurfpoolVersion(text: string): [number, number, number] | undefined;
/**
 * Throw {@link SurfpoolNotFoundError} unless `surfpool --version` runs and reports
 * {@link SURFPOOL_VERSION} or newer. Synchronous, so a runner adapter can call it while collecting
 * tests: a missing surfpool is a collection error, never a skipped suite. Returns the version.
 */
export declare function assertSurfpoolInstalled(binary?: string): string;
//# sourceMappingURL=surfpool.d.ts.map