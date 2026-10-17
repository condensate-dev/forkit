import type { Redactor } from "./redact.ts";
/**
 * A body, stored in the most readable lossless form: `json` (parsed), `text`, or `base64` for
 * bytes that are not UTF-8. Absent when the body is empty.
 */
export interface FixtureBody {
    json?: unknown;
    text?: string;
    base64?: string;
}
export interface FixtureRequest extends FixtureBody {
    method: string;
    /** Redacted URL. */
    url: string;
    /** Headers the caller set, redacted. Informational unless named in `matchHeaders`. */
    headers: Record<string, string>;
}
export interface FixtureResponse extends FixtureBody {
    status: number;
    statusText: string;
    /** Response headers, redacted, minus transport and volatile ones. */
    headers: Record<string, string>;
}
export interface FixtureEntry {
    request: FixtureRequest;
    response: FixtureResponse;
}
export interface FixtureFile {
    version: 1;
    name: string;
    /** Fork block the responses were recorded at (decimal). */
    blockNumber: string;
    chainId?: number;
    /**
     * Sorted by request. Requests that repeat (a status endpoint polled until it settles) keep
     * their recorded order and replay in it.
     */
    entries: FixtureEntry[];
}
/** How requests are matched to recordings, beyond method + URL + body. */
export interface MatchOptions {
    /** Query parameters to ignore (case-insensitive), e.g. a timestamp or a nonce. */
    ignoreQuery?: readonly string[];
    /** JSON body fields to ignore, as dotted paths (`"deadline"`, `"quote.nonce"`). */
    ignoreBody?: readonly string[];
    /** Request headers that take part in matching (case-insensitive), e.g. an API version header. */
    matchHeaders?: readonly string[];
}
/** `<dir>/<name>.json`. Names may contain `/` for subdirectories, but not `..`. */
export declare function fixturePath(dir: string, name: string): string;
export declare function encodeBody(bytes: Uint8Array, contentType: string | null): FixtureBody;
export declare function decodeBody(body: FixtureBody): Uint8Array | string | undefined;
export declare function responseHeaders(headers: Headers, redactor: Redactor): Record<string, string>;
/**
 * The matching key: method, URL (redacted, query sorted, ignored params dropped), the headers
 * named in `matchHeaders`, and the body (JSON canonicalised, ignored fields dropped). Built from
 * the stored form, so a recording and a live request are compared the same way.
 */
export declare function matchKey(request: FixtureRequest, redactor: Redactor, match?: MatchOptions): string;
/** Read a fixture file; `undefined` when there is none. A corrupt file is an error, not a miss. */
export declare function readFixtureFile(path: string): FixtureFile | undefined;
/** Write atomically (tmp + rename), so a parallel reader never sees half a file. */
export declare function writeFixtureFile(path: string, file: FixtureFile): void;
//# sourceMappingURL=fixtures.d.ts.map