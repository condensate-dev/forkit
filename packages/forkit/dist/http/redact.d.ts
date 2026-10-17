/**
 * Secret redaction for recorded HTTP traffic. Fixtures are meant to be committed, so API keys
 * must never reach them. Matching happens on the redacted form, so a replay with a different
 * (or no) key still finds the recording.
 */
/** What a secret is replaced with, in URLs and headers. */
export declare const REDACTED = "<redacted>";
/** Headers redacted by name (case-insensitive). */
export declare const DEFAULT_REDACTED_HEADERS: readonly string[];
/**
 * Query parameters redacted by exact name (case-insensitive). Exact, not by pattern: quote APIs
 * take params like `sellToken`, and redacting those would make different quotes collide.
 */
export declare const DEFAULT_REDACTED_QUERY: readonly string[];
/** Extra names to redact, on top of the defaults. */
export interface RedactOptions {
    /** Header names (case-insensitive). */
    headers?: readonly string[];
    /** Query parameter names (case-insensitive). */
    query?: readonly string[];
}
export interface Redactor {
    url(url: string): string;
    isSecretHeader(name: string): boolean;
    headers(headers: Headers): Record<string, string>;
}
export declare function createRedactor(options?: RedactOptions): Redactor;
//# sourceMappingURL=redact.d.ts.map