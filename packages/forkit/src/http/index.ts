/**
 * @condensate/forkit/http: record and replay the HTTP quote APIs (0x, Relay, Across, ...) that
 * production code calls, pinned to the fork block the quotes were taken at.
 *
 * ```ts
 * const h = http.use({ name: "0x-usdc-weth", blockNumber: 21_000_000n, chainId: 8453 });
 * const quote = await getQuote(...); // production code's own fetch, unchanged
 * await h.stop();                    // restores fetch, writes new recordings
 * ```
 *
 * `FORKIT_HTTP=record|replay|auto|off` picks the mode; CI (`CI` set) replays by default, with no
 * network and no API keys. See docs/guides/http-replay.md.
 */
import { record, replay, use, withHttp } from "./intercept.ts";

export {
  type FixtureBody,
  type FixtureEntry,
  type FixtureFile,
  type FixtureRequest,
  type FixtureResponse,
  fixturePath,
  type MatchOptions,
} from "./fixtures.ts";
export {
  DEFAULT_HTTP_DIR,
  HTTP_DIR_ENV,
  HTTP_MODE_ENV,
  HTTP_MODES,
  type HttpFixtures,
  type HttpMode,
  type HttpOptions,
  type HttpStats,
  HttpUnmatchedError,
  record,
  replay,
  resolveHttpSettings,
  use,
  withHttp,
} from "./intercept.ts";
export {
  createRedactor,
  DEFAULT_REDACTED_HEADERS,
  DEFAULT_REDACTED_QUERY,
  REDACTED,
  type RedactOptions,
  type Redactor,
} from "./redact.ts";

/** The same functions as a namespace, for `http.record(...)` / `http.replay(...)` call sites. */
export const http = { use, record, replay, with: withHttp } as const;
