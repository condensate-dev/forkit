/**
 * `fetch` interception for quote-API record and replay.
 *
 * `globalThis.fetch` is swapped for a wrapper, so production code's own `fetch` calls are
 * intercepted unchanged, with no import changes and no runtime dependency. Only one fixture set
 * is active at a time: two layers of mocks over one global would make it unclear who answered.
 */
import { ForkitError } from "../errors.ts";
import { type MatchOptions } from "./fixtures.ts";
import { type RedactOptions } from "./redact.ts";
/**
 * - `record`: every request goes to the network; responses are saved, replacing earlier
 *   recordings of the same request.
 * - `replay`: fixtures only, no network (the default when `CI` is set). What happens to a
 *   request with no recording is set by `unmatched`.
 * - `auto`: replay what is recorded and record what is missing (the default otherwise).
 * - `off`: no interception at all; `fetch` is untouched.
 */
export type HttpMode = "record" | "replay" | "auto" | "off";
export declare const HTTP_MODES: readonly HttpMode[];
/** Env override for the mode, e.g. `FORKIT_HTTP=replay` in CI. */
export declare const HTTP_MODE_ENV = "FORKIT_HTTP";
/** Env override for the fixture directory. */
export declare const HTTP_DIR_ENV = "FORKIT_HTTP_DIR";
/** Default fixture directory, relative to the working directory. Meant to be committed. */
export declare const DEFAULT_HTTP_DIR = ".forkit-http";
export interface HttpOptions extends MatchOptions {
    /** Fixture set name; the file is `<dir>/<name>.json`. May contain `/` for subdirectories. */
    name: string;
    /** Fork block the responses belong to. Recorded with them; replaying at another block warns. */
    blockNumber: bigint | number;
    /** Chain of that block, for multi-chain suites. Checked like the block when both sides have one. */
    chainId?: number;
    /** Default `FORKIT_HTTP`, else `replay` when `CI` is set, else `auto`. */
    mode?: HttpMode;
    /** Default `FORKIT_HTTP_DIR` or `.forkit-http` in the working directory. */
    dir?: string;
    /**
     * A replayed request with no recording: `error` (default) rejects the `fetch` with
     * {@link HttpUnmatchedError}; `passthrough` sends it to the network without recording it.
     */
    unmatched?: "error" | "passthrough";
    /**
     * Replaying fixtures recorded at another block (or chain): `warn` (default) or `error`. A quote
     * is only valid for the state it was priced against.
     */
    blockMismatch?: "warn" | "error";
    /** Extra header and query-parameter names to redact, on top of the defaults. */
    redact?: RedactOptions;
    /**
     * Hosts to intercept (`api.0x.org`, or `host:port`). Everything else goes to the network
     * untouched. By default every host is intercepted except loopback, where the fork's own anvil
     * listens.
     */
    hosts?: readonly string[];
    /** Where warnings go. Default `console.warn`. */
    onWarn?: (message: string) => void;
}
export interface HttpStats {
    readonly name: string;
    readonly path: string;
    readonly mode: HttpMode;
    /** Requests answered from the fixtures. */
    readonly hits: number;
    /** Responses recorded this run. */
    readonly recorded: number;
    /** Requests sent to the network without being recorded. */
    readonly passthrough: number;
    /** `METHOD url` (redacted) of every request with no recording, refused or passed through. */
    readonly unmatched: readonly string[];
    /** Entries in the fixture set, including this run's recordings. */
    readonly entries: number;
}
/** A running fixture set. `stop()` restores `fetch` and writes new recordings. */
export interface HttpFixtures {
    readonly name: string;
    readonly mode: HttpMode;
    /** Absolute path of the fixture file. */
    readonly path: string;
    stats(): HttpStats;
    /** Restore the original `fetch`, wait for in-flight recordings, and write them. Idempotent. */
    stop(): Promise<void>;
}
/** A request with no recording, in `replay` mode with `unmatched: "error"`. */
export declare class HttpUnmatchedError extends ForkitError {
    name: string;
    readonly method: string;
    /** Redacted URL. */
    readonly url: string;
    /** The fixture file that has no recording for it. */
    readonly path: string;
    constructor(method: string, url: string, path: string, fileExists: boolean);
}
/** Resolve the mode and directory from options, then env, then defaults. */
export declare function resolveHttpSettings(mode: HttpMode | undefined, dir: string | undefined, env?: Readonly<Record<string, string | undefined>>): {
    mode: HttpMode;
    dir: string;
};
/** Start a fixture set in the mode from `options`, `FORKIT_HTTP`, or the default. */
export declare function use(options: HttpOptions): HttpFixtures;
/** Record: every request goes to the network, and responses are saved at `blockNumber`. */
export declare function record(options: Omit<HttpOptions, "mode">): HttpFixtures;
/** Replay: serve the fixtures with no network. */
export declare function replay(options: Omit<HttpOptions, "mode">): HttpFixtures;
/** Run `fn` with a fixture set active, and stop it afterwards whether `fn` throws or not. */
export declare function withHttp<T>(options: HttpOptions, fn: (fixtures: HttpFixtures) => Promise<T> | T): Promise<T>;
//# sourceMappingURL=intercept.d.ts.map