# HTTP quote record and replay: `@condensate/forkit/http`

Quote APIs (0x, Relay, Across, ...) answer with prices and calldata that are only valid for the chain state they were priced against. A fork test that calls them live needs an API key, depends on the network, and gets a different quote every run. `@condensate/forkit/http` records those responses once, **pinned to the fork block**, and replays them in CI with no network and no key.

It intercepts `globalThis.fetch`, so production code's own `fetch` calls are captured unchanged: nothing is injected and there is no new dependency.

## Usage

```ts
import { http } from "@condensate/forkit/http";

const BLOCK = 21_000_000n;
const f = await fork({ chain: base, blockNumber: BLOCK });
const h = http.use({ name: "0x/usdc-weth", blockNumber: BLOCK, chainId: base.id });

const quote = await getSwapQuote({ sellToken: USDC, buyToken: WETH, amount }); // your code, unchanged
await f.client.sendTransaction(quote.tx);

await h.stop(); // restores fetch and writes new recordings
```

In a suite, start the set in `beforeAll` and stop it in `afterAll`, or scope it:

```ts
await http.with({ name: "relay/base-arb", blockNumber: BLOCK }, async (h) => {
  await runRoute();
  expect(h.stats().hits).toBe(2);
});
```

### What is intercepted

Every `fetch` to a non-loopback host, except JSON-RPC. The fork's own traffic stays out of the fixtures:

- viem clients talk to anvil on `127.0.0.1`;
- the [fork cache](fork-cache-and-ci.md) records the upstream JSON-RPC by block, and it does that better.

Pass `hosts: ["api.0x.org", "api.relay.link"]` to intercept only those hosts (`host` or `host:port`, which is also how a local stub server is included). Anything not intercepted goes to the network untouched and does not appear in the stats.

`http.record(options)` and `http.replay(options)` force a mode, and `http.use(options)` takes it from the environment. Prefer `use`, so CI can force replay without a code change.

## Modes

| `FORKIT_HTTP` / `mode:` | behaviour |
|---|---|
| `auto` (default locally) | replay recorded requests, record missing ones |
| `replay` (default when `CI` is set) | fixtures only, no network; unmatched requests fail (see below) |
| `record` | every request goes to the network, and each response replaces its earlier recording |
| `off` | no interception; `fetch` is untouched |

An explicit `mode` wins over `FORKIT_HTTP`, and `FORKIT_HTTP` wins over the default. `FORKIT_HTTP_DIR` (or `dir:`) sets the fixture directory; the default is `.forkit-http` in the working directory. Commit it.

`auto` does not record 401, 403, 407, 429 or 5xx responses: without an API key locally you would otherwise commit an auth error. It warns instead. `record` saves whatever it gets.

To re-record everything, delete the file, or run with `FORKIT_HTTP=record` and network access (plus the API keys your code reads).

## Pinned to the fork block

Every fixture file records the `blockNumber` (and `chainId`, if given) it was taken at.

- Replaying at another block or chain warns: `fixture set "0x/usdc-weth" was recorded at block 21000000 (chain 8453), but this fork is at block 21000100 ...`. Use `blockMismatch: "error"` to fail instead. A quote whose calldata was priced against other state tends to revert opaquely, and this says why first.
- `record` at a new block replaces the file's recordings (it warns how many), so one file never mixes blocks.
- `auto` at a mismatched block serves what matches and passes misses to the network, but it does not add them to the file.

## Matching

A request matches a recording on method, URL and body:

- The URL is compared after redaction, with query parameters sorted and the fragment dropped.
- JSON bodies are compared canonically, so key order does not matter.
- Headers are not compared, unless named in `matchHeaders` (e.g. an API-version header).

To ignore volatile parts, pass `ignoreQuery: ["timestamp"]` and `ignoreBody: ["deadline", "quote.nonce"]` (dotted paths into a JSON body).

A request that repeats (a status endpoint polled until a fill lands) replays its recordings in the order they were made, then the last one repeats.

### Unmatched requests

In `replay`, a request with no recording rejects its `fetch` with `HttpUnmatchedError`, which names the method, the redacted URL and the fixture file:

```
forkit/http: no recording for GET https://api.0x.org/swap/permit2/quote?chainId=8453&sellToken=...
  in /repo/.forkit-http/0x/usdc-weth.json.
Record it by running once with FORKIT_HTTP=record (or auto) and network access, or pass unmatched: "passthrough".
```

Code under test may catch that error and fall back to something else, so `stop()` also warns with every unmatched request, and `stats().unmatched` lists them. `unmatched: "passthrough"` sends unmatched requests to the network without recording them.

## Secrets

Recordings are meant to be committed, so secrets are replaced with `<redacted>` before anything is written:

- **Headers**, request and response: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `0x-api-key`, `api-key`, `apikey`, `x-auth-token`, plus any header whose name contains `api-key`/`apikey`/`api_key`, `token`, `secret`, `password`, `auth`, `cookie` or `session`.
- **Query parameters**, by exact name, case-insensitive: `apiKey`, `api_key`, `api-key`, `key`, `token`, `access_token`, `secret`, `password`. Matching is by exact name so that params like `sellToken` stay intact.
- **URL credentials** (`user:pass@`).
- **Your own names**: `redact: { headers: ["x-partner-id"], query: ["partner"] }`.

Matching uses the redacted form, so CI replays with a different key, or none.

Bodies are not redacted. If an API echoes a secret in a body, review the fixture before committing it.

## Fixture format

One file per set, `<dir>/<name>.json`, where `name` may contain `/`. Keys are sorted, and entries are sorted by request, so a re-recording diffs cleanly:

```json
{
  "blockNumber": "21000000",
  "chainId": 8453,
  "entries": [
    {
      "request": {
        "headers": { "0x-api-key": "<redacted>", "0x-version": "v2" },
        "method": "GET",
        "url": "https://api.0x.org/swap/permit2/quote?chainId=8453&sellToken=0x8335...&sellAmount=1000000"
      },
      "response": {
        "headers": { "content-type": "application/json" },
        "json": { "buyAmount": "412345678901234", "transaction": { "to": "0x...", "data": "0x..." } },
        "status": 200,
        "statusText": "OK"
      }
    }
  ],
  "name": "0x/usdc-weth",
  "version": 1
}
```

A body is stored as `json` when parsing it loses nothing. It is stored as `text` otherwise: for example, a number too large for a double stays exact. Bytes that are not UTF-8 are stored as `base64`. Transport headers that no longer describe the stored body are dropped: `content-length`, `content-encoding`, `transfer-encoding`, `connection`, `keep-alive`, `date` and `age`.

Parallel workers recording into the same set merge at `stop()`. Writes are atomic.

## Scope and limits

- Only `globalThis.fetch` is intercepted, which covers Node's built-in fetch, Bun, and libraries built on them (viem's HTTP transport, most SDKs). Code that imports `undici`'s own `fetch`, or uses `node:http` / axios's Node adapter, is not intercepted.
- One fixture set is active at a time. Starting a second one throws and names the active one.
- If something else replaces `fetch` while a set is active (msw, say), `stop()` leaves that in place, warns, and forkit's layer passes straight through from then on.
- A replayed `Response` has the request's `url`, but `redirected` is always false.

## API

```ts
http.use(options: HttpOptions): HttpFixtures      // mode from options / FORKIT_HTTP / default
http.record(options): HttpFixtures                // mode: "record"
http.replay(options): HttpFixtures                // mode: "replay"
http.with(options, fn: (h) => T): Promise<T>      // use, run fn, stop (also exported as withHttp)

interface HttpOptions {
  name: string; blockNumber: bigint | number; chainId?: number;
  mode?: "record" | "replay" | "auto" | "off"; dir?: string;
  unmatched?: "error" | "passthrough"; blockMismatch?: "warn" | "error";
  hosts?: string[]; ignoreQuery?: string[]; ignoreBody?: string[]; matchHeaders?: string[];
  redact?: { headers?: string[]; query?: string[] };
  onWarn?: (message: string) => void;
}

interface HttpFixtures {
  name: string; mode: HttpMode; path: string;
  stats(): { hits; recorded; passthrough; unmatched: string[]; entries; ... };
  stop(): Promise<void>;   // idempotent
}
```

`use`, `record`, `replay` and `withHttp` are also exported as named functions, along with `resolveHttpSettings`, `HttpUnmatchedError`, `createRedactor` and the fixture types.
