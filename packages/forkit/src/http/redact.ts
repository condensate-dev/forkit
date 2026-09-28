/**
 * Secret redaction for recorded HTTP traffic. Fixtures are meant to be committed, so API keys
 * must never reach them. Matching happens on the redacted form, so a replay with a different
 * (or no) key still finds the recording.
 */

/** What a secret is replaced with, in URLs and headers. */
export const REDACTED = "<redacted>";

/** Headers redacted by name (case-insensitive). */
export const DEFAULT_REDACTED_HEADERS: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "0x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
];

/**
 * Header names that look like credentials are redacted too, so a provider-specific
 * `x-<vendor>-api-key` does not slip through. Headers take no part in matching, so erring on the
 * side of redaction costs nothing.
 */
const SECRET_HEADER_PATTERN = /api[-_]?key|token|secret|password|auth|cookie|session/i;

/**
 * Query parameters redacted by exact name (case-insensitive). Exact, not by pattern: quote APIs
 * take params like `sellToken`, and redacting those would make different quotes collide.
 */
export const DEFAULT_REDACTED_QUERY: readonly string[] = [
  "apikey",
  "api_key",
  "api-key",
  "key",
  "token",
  "access_token",
  "secret",
  "password",
];

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

export function createRedactor(options: RedactOptions = {}): Redactor {
  const headerNames = new Set(
    [...DEFAULT_REDACTED_HEADERS, ...(options.headers ?? [])].map((h) => h.toLowerCase()),
  );
  const queryNames = new Set(
    [...DEFAULT_REDACTED_QUERY, ...(options.query ?? [])].map((q) => q.toLowerCase()),
  );
  const isSecretHeader = (name: string): boolean =>
    headerNames.has(name.toLowerCase()) || SECRET_HEADER_PATTERN.test(name);
  return {
    isSecretHeader,
    url(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return url;
      }
      // Rebuilt by hand: URL setters would percent-encode `<redacted>`. The fragment never
      // reaches the server, so it is dropped.
      const userinfo = parsed.username !== "" || parsed.password !== "" ? `${REDACTED}@` : "";
      const query =
        parsed.search === ""
          ? ""
          : `?${parsed.search
              .slice(1)
              .split("&")
              .map((part) => {
                const eq = part.indexOf("=");
                if (eq === -1) return part;
                const name = safeDecode(part.slice(0, eq)).toLowerCase();
                return queryNames.has(name) ? `${part.slice(0, eq)}=${REDACTED}` : part;
              })
              .join("&")}`;
      return `${parsed.protocol}//${userinfo}${parsed.host}${parsed.pathname}${query}`;
    },
    headers(headers) {
      const out: Record<string, string> = {};
      headers.forEach((value, name) => {
        out[name.toLowerCase()] = isSecretHeader(name) ? REDACTED : value;
      });
      return out;
    },
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}
