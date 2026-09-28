import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createRedactor,
  type FixtureFile,
  type HttpOptions,
  HttpUnmatchedError,
  http,
  resolveHttpSettings,
  withHttp,
} from "../../src/http/index.ts";

/**
 * A local quote API. Every answer carries a counter, so a replayed response is told apart from a
 * fresh one by its `n`.
 */
let server: Server;
let base: string;
let served = 0;
let statusPolls = 0;

async function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      served++;
      const url = new URL(req.url ?? "/", "http://localhost");
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      switch (url.pathname) {
        case "/quote":
          return json(
            200,
            {
              n: served,
              sellToken: url.searchParams.get("sellToken"),
              body: Buffer.concat(chunks).toString(),
            },
            {
              "set-cookie": "session=abc123",
              "x-request-id": "r1",
            },
          );
        case "/status":
          statusPolls++;
          return json(200, { status: statusPolls >= 2 ? "filled" : "pending" });
        case "/big":
          res.writeHead(200, { "content-type": "application/json" });
          return res.end('{"amount":123456789012345678901234}');
        case "/bytes":
          res.writeHead(200, { "content-type": "application/octet-stream" });
          return res.end(Buffer.from([0xff, 0x00, 0xfe, 0x01]));
        case "/empty":
          res.writeHead(204);
          return res.end();
        case "/fail":
          return json(500, { error: "boom" });
        default:
          return json(404, { error: "not found" });
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stopServer(): Promise<void> {
  await new Promise<void>((ok) => {
    server.close(() => ok());
    server.closeAllConnections();
  });
}

let dir: string;
let warnings: string[];
const nativeFetch = globalThis.fetch;

function options(extra: Partial<HttpOptions> = {}): HttpOptions {
  return {
    name: "quotes",
    dir,
    blockNumber: 100n,
    chainId: 8453,
    // The test server is on loopback, which is not intercepted by default.
    hosts: [new URL(base).host],
    onWarn: (message) => warnings.push(message),
    ...extra,
  };
}

function readFixture(name = "quotes"): FixtureFile {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as FixtureFile;
}

async function getJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  return (await (await fetch(url, init)).json()) as Record<string, unknown>;
}

beforeAll(startServer);
afterAll(async () => {
  if (server.listening) await stopServer();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forkit-http-"));
  warnings = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  expect(globalThis.fetch).toBe(nativeFetch);
});

describe("record, then replay with the server down", () => {
  test("serves the recorded response, not a fresh one", async () => {
    const rec = http.record(options());
    const recorded = await getJson(`${base}/quote?sellToken=USDC&amount=1`);
    const stats = rec.stats();
    await rec.stop();
    expect(stats).toMatchObject({ mode: "record", recorded: 1, hits: 0 });

    await stopServer();
    try {
      const rep = http.replay(options());
      const response = await fetch(`${base}/quote?amount=1&sellToken=USDC`); // query order ignored
      expect(response.status).toBe(200);
      expect(response.url).toBe(`${base}/quote?amount=1&sellToken=USDC`);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual(recorded);
      expect(rep.stats()).toMatchObject({ hits: 1, recorded: 0, passthrough: 0, entries: 1 });
      await rep.stop();
    } finally {
      await startServer();
    }
    expect(warnings).toEqual([]);
  });
});

describe("http", () => {
  test("fixture file: pinned block and chain, sorted keys, readable bodies", async () => {
    await withHttp(options({ mode: "record" }), async () => {
      await fetch(`${base}/quote?b=2`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ z: 1, a: 2 }),
      });
      await fetch(`${base}/big`);
      await fetch(`${base}/bytes`);
      await fetch(`${base}/empty`);
    });
    const text = readFileSync(join(dir, "quotes.json"), "utf8");
    const file = JSON.parse(text) as FixtureFile;
    expect(Object.keys(file)).toEqual(["blockNumber", "chainId", "entries", "name", "version"]);
    expect(file).toMatchObject({ version: 1, name: "quotes", blockNumber: "100", chainId: 8453 });
    expect(file.entries.map((e) => e.request.url.replace(base, ""))).toEqual([
      "/big",
      "/bytes",
      "/empty",
      "/quote?b=2",
    ]);
    const [big, bytes, empty, quote] = file.entries;
    expect(big?.response.text).toBe('{"amount":123456789012345678901234}'); // not rounded
    expect(bytes?.response.base64).toBe("/wD+AQ==");
    expect(empty?.response).toEqual({ headers: {}, status: 204, statusText: "No Content" });
    expect(quote?.request.json).toEqual({ z: 1, a: 2 });
    expect(Object.keys(quote?.response ?? {})).toEqual(["headers", "json", "status", "statusText"]);
    // Transport and volatile headers are dropped.
    expect(quote?.response.headers).not.toHaveProperty("date");
    expect(quote?.response.headers).not.toHaveProperty("content-length");
    expect(text.endsWith("}\n")).toBe(true);

    await stopServer();
    try {
      await withHttp(options({ mode: "replay" }), async () => {
        expect(await (await fetch(`${base}/big`)).text()).toBe(
          '{"amount":123456789012345678901234}',
        );
        expect([...new Uint8Array(await (await fetch(`${base}/bytes`)).arrayBuffer())]).toEqual([
          0xff, 0x00, 0xfe, 0x01,
        ]);
        const empty204 = await fetch(`${base}/empty`);
        expect(empty204.status).toBe(204);
        expect(await empty204.text()).toBe("");
      });
    } finally {
      await startServer();
    }
  });

  test("redacts secrets from URLs and headers, and still matches on the redacted form", async () => {
    const secretUrl = `${base}/quote?sellToken=USDC&apiKey=sk-live-1&api_key=k2&KEY=k3&token=t4&myKey=k5`;
    await withHttp(
      options({ mode: "record", redact: { query: ["myKey"], headers: ["x-vendor"] } }),
      () =>
        fetch(secretUrl, {
          headers: {
            authorization: "Bearer secret-bearer",
            cookie: "sid=secret-cookie",
            "x-api-key": "secret-x",
            "0x-api-key": "secret-0x",
            "x-relay-api-key": "secret-pattern",
            "x-vendor": "secret-vendor",
            accept: "application/json",
          },
        }),
    );
    const text = readFileSync(join(dir, "quotes.json"), "utf8");
    for (const secret of ["sk-live-1", "k2", "k3", "t4", "k5", "secret-", "abc123"]) {
      expect(text).not.toContain(secret);
    }
    const [entry] = readFixture().entries;
    expect(entry?.request.url).toBe(
      `${base}/quote?sellToken=USDC&apiKey=<redacted>&api_key=<redacted>&KEY=<redacted>&token=<redacted>&myKey=<redacted>`,
    );
    expect(entry?.request.headers).toMatchObject({
      authorization: "<redacted>",
      cookie: "<redacted>",
      "x-api-key": "<redacted>",
      "0x-api-key": "<redacted>",
      "x-relay-api-key": "<redacted>",
      "x-vendor": "<redacted>",
      accept: "application/json",
    });
    expect(entry?.response.headers["set-cookie"]).toBe("<redacted>");
    expect(entry?.response.headers["x-request-id"]).toBe("r1");

    // CI has no key, or another one: the redacted form still matches.
    await withHttp(options({ mode: "replay", redact: { query: ["myKey"] } }), async (h) => {
      await fetch(`${base}/quote?sellToken=USDC&apiKey=other&api_key=x&KEY=y&token=z&myKey=w`);
      expect(h.stats().hits).toBe(1);
      // A different sellToken is a different quote: `token` is redacted by exact name only.
      await expect(fetch(`${base}/quote?sellToken=WETH&apiKey=other`)).rejects.toThrow(
        HttpUnmatchedError,
      );
    });
  });

  test("redactor: userinfo, fragments, and names are case-insensitive", () => {
    const r = createRedactor();
    expect(r.url("https://user:pw@api.example.com/v1/x?ApiKey=1&amount=2#frag")).toBe(
      "https://<redacted>@api.example.com/v1/x?ApiKey=<redacted>&amount=2",
    );
    expect(r.headers(new Headers({ Authorization: "x", "Content-Type": "y" }))).toEqual({
      authorization: "<redacted>",
      "content-type": "y",
    });
  });

  test("matches on method, URL and body; JSON key order and ignored fields do not matter", async () => {
    const post = (body: unknown, url = `${base}/quote`) =>
      fetch(url, { method: "POST", body: JSON.stringify(body) });
    await withHttp(options({ mode: "record" }), () =>
      post({ amount: "1", deadline: 1, nested: { a: 1, b: 2 } }, `${base}/quote?ts=1`),
    );
    await withHttp(
      options({ mode: "replay", ignoreBody: ["deadline"], ignoreQuery: ["ts"] }),
      async (h) => {
        await post({ nested: { b: 2, a: 1 }, deadline: 999, amount: "1" }, `${base}/quote?ts=2`);
        expect(h.stats().hits).toBe(1);
        await expect(post({ amount: "2", nested: { a: 1, b: 2 } })).rejects.toThrow(
          HttpUnmatchedError,
        );
        await expect(fetch(`${base}/quote?ts=3`)).rejects.toThrow(/no recording for GET/);
      },
    );
    await withHttp(options({ mode: "replay" }), async () => {
      // Without the ignore rules the volatile field is part of the match.
      await expect(post({ amount: "1", deadline: 2, nested: { a: 1, b: 2 } })).rejects.toThrow(
        HttpUnmatchedError,
      );
    });
  });

  test("matchHeaders makes a header part of the match", async () => {
    const get = (version: string) => fetch(`${base}/quote`, { headers: { "x-version": version } });
    await withHttp(options({ mode: "record", matchHeaders: ["X-Version"] }), () => get("v2"));
    await withHttp(options({ mode: "replay", matchHeaders: ["X-Version"] }), async () => {
      await get("v2");
      await expect(get("v1")).rejects.toThrow(HttpUnmatchedError);
    });
    await withHttp(options({ mode: "replay" }), () => get("v1"));
  });

  test("repeated requests replay in recorded order, then the last answer repeats", async () => {
    statusPolls = 0;
    await withHttp(options({ mode: "record" }), async () => {
      for (let i = 0; i < 3; i++) await fetch(`${base}/status`);
    });
    expect(
      readFixture().entries.map((e) => (e.response.json as { status: string }).status),
    ).toEqual(["pending", "filled", "filled"]);
    await withHttp(options({ mode: "replay" }), async () => {
      const seen = [];
      for (let i = 0; i < 4; i++) seen.push((await getJson(`${base}/status`)).status);
      expect(seen).toEqual(["pending", "filled", "filled", "filled"]);
    });
  });

  test("unmatched: error names method, URL and fixture file; passthrough goes to the network", async () => {
    const rep = http.replay(options());
    const error = await fetch(`${base}/quote?apiKey=secret`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpUnmatchedError);
    const unmatched = error as HttpUnmatchedError;
    expect(unmatched.method).toBe("GET");
    expect(unmatched.url).toBe(`${base}/quote?apiKey=<redacted>`);
    expect(unmatched.path).toBe(join(dir, "quotes.json"));
    expect(unmatched.message).toContain(`GET ${base}/quote?apiKey=<redacted>`);
    expect(unmatched.message).toContain(join(dir, "quotes.json"));
    expect(unmatched.message).toContain("does not exist");
    expect(unmatched.message).not.toContain("secret");
    await rep.stop();
    // Code may swallow the rejection; stop() reports it anyway.
    expect(warnings.join("\n")).toContain(`1 request(s) had no recording`);

    const before = served;
    await withHttp(options({ mode: "replay", unmatched: "passthrough" }), async (h) => {
      expect((await getJson(`${base}/quote`)).n).toBe(before + 1);
      expect(h.stats()).toMatchObject({
        passthrough: 1,
        recorded: 0,
        unmatched: [`GET ${base}/quote`],
      });
    });
    expect(() => readFixture()).toThrow(); // nothing recorded
  });

  test("replaying at another block warns, or throws with blockMismatch: error", async () => {
    await withHttp(options({ mode: "record" }), () => fetch(`${base}/quote`));
    await withHttp(options({ mode: "replay", blockNumber: 101 }), () => fetch(`${base}/quote`));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /recorded at block 100 \(chain 8453\), but this fork is at block 101/,
    );

    warnings = [];
    await withHttp(options({ mode: "replay", chainId: 42161 }), () => fetch(`${base}/quote`));
    expect(warnings[0]).toMatch(/chain 8453.*chain 42161/);

    expect(() => http.replay(options({ blockNumber: 101n, blockMismatch: "error" }))).toThrow(
      /recorded at block 100/,
    );
    expect(globalThis.fetch).toBe(nativeFetch);
  });

  test("recording at a new block replaces the old recordings", async () => {
    await withHttp(options({ mode: "record" }), () => fetch(`${base}/quote?a=1`));
    await withHttp(options({ mode: "record", blockNumber: 200n }), () =>
      fetch(`${base}/quote?a=2`),
    );
    expect(warnings[0]).toMatch(/re-recording "quotes" at block 200/);
    const file = readFixture();
    expect(file.blockNumber).toBe("200");
    expect(file.entries.map((e) => e.request.url)).toEqual([`${base}/quote?a=2`]);
  });

  test("record at the same block merges, replacing re-recorded requests", async () => {
    await withHttp(options({ mode: "record" }), async () => {
      await fetch(`${base}/quote?a=1`);
      await fetch(`${base}/quote?a=2`);
    });
    const first = readFixture().entries.map((e) => (e.response.json as { n: number }).n);
    await withHttp(options({ mode: "record" }), () => fetch(`${base}/quote?a=2`));
    const second = readFixture().entries.map((e) => (e.response.json as { n: number }).n);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second).toHaveLength(2);
  });

  test("auto replays hits, records misses, and skips transient failures", async () => {
    await withHttp(options({ mode: "record" }), () => fetch(`${base}/quote?a=1`));
    const before = served;
    await withHttp(options({ mode: "auto" }), async (h) => {
      await fetch(`${base}/quote?a=1`);
      await fetch(`${base}/quote?a=2`);
      expect((await fetch(`${base}/fail`)).status).toBe(500);
      expect(h.stats()).toMatchObject({ hits: 1, recorded: 1, passthrough: 1, unmatched: [] });
    });
    expect(served).toBe(before + 2);
    expect(readFixture().entries).toHaveLength(2);
    expect(warnings.join("\n")).toMatch(/not recording GET .*\/fail: HTTP 500/);
  });

  test("auto at another block does not mix blocks in one file", async () => {
    await withHttp(options({ mode: "record" }), () => fetch(`${base}/quote?a=1`));
    await withHttp(options({ mode: "auto", blockNumber: 101n }), async (h) => {
      await fetch(`${base}/quote?a=2`);
      expect(h.stats()).toMatchObject({ recorded: 0, passthrough: 1 });
    });
    expect(readFixture()).toMatchObject({ blockNumber: "100", entries: [{}] });
  });

  test("loopback, other hosts and JSON-RPC go to the network untouched", async () => {
    const { hosts: _, ...noHosts } = options({ mode: "replay" });
    await withHttp(noHosts, async (h) => {
      // The fork's anvil listens on loopback: never intercepted unless named in `hosts`.
      expect((await getJson(`${base}/quote`)).n).toBeTypeOf("number");
      expect(h.stats()).toMatchObject({ hits: 0, passthrough: 0, unmatched: [] });
    });
    await withHttp(options({ mode: "replay", hosts: ["api.example.com"] }), async (h) => {
      expect((await getJson(`${base}/quote`)).n).toBeTypeOf("number");
      expect(h.stats().unmatched).toEqual([]);
    });
    await withHttp(options({ mode: "replay" }), async (h) => {
      // viem clients and the fork cache speak JSON-RPC; the fork cache records that traffic.
      const rpc = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
      const response = await fetch(`${base}/rpc`, { method: "POST", body: JSON.stringify(rpc) });
      expect(response.status).toBe(404); // reached the server
      await fetch(`${base}/rpc`, { method: "POST", body: JSON.stringify([rpc]) });
      expect(h.stats().unmatched).toEqual([]);
    });
  });

  test("off leaves fetch alone", async () => {
    const h = http.use(options({ mode: "off" }));
    expect(globalThis.fetch).toBe(nativeFetch);
    await fetch(`${base}/quote`);
    await h.stop();
    expect(h.stats()).toMatchObject({ mode: "off", hits: 0, recorded: 0 });
  });

  test("stop restores fetch, is idempotent, and one set is active at a time", async () => {
    const h = http.replay(options());
    expect(globalThis.fetch).not.toBe(nativeFetch);
    expect(() => http.record(options({ name: "other" }))).toThrow(
      /already intercepted by fixture set "quotes"/,
    );
    await h.stop();
    await h.stop();
    expect(globalThis.fetch).toBe(nativeFetch);
    await http.record(options({ name: "other" })).stop();
  });

  test("withHttp stops even when the body throws", async () => {
    await expect(
      withHttp(options({ mode: "replay" }), () => {
        throw new Error("test failed");
      }),
    ).rejects.toThrow("test failed");
    expect(globalThis.fetch).toBe(nativeFetch);
  });

  test("a fetch replaced on top of ours is left in place, and ours passes through", async () => {
    const h = http.replay(options());
    const ours = globalThis.fetch;
    const other = ((input: string | URL | Request, init?: RequestInit) =>
      ours(input, init)) as typeof fetch;
    globalThis.fetch = other;
    await h.stop();
    expect(globalThis.fetch).toBe(other);
    expect(warnings[0]).toMatch(/replaced while "quotes" was active/);
    // Stopped: no longer refuses unmatched requests.
    expect((await getJson(`${base}/quote`)).n).toBeTypeOf("number");
    globalThis.fetch = nativeFetch;
  });

  test("rejects bad names and missing blockNumber", () => {
    expect(() => http.replay(options({ name: "../escape" }))).toThrow(/fixture name/);
    expect(() => http.replay(JSON.parse(JSON.stringify({ name: "x", dir })))).toThrow(
      /blockNumber/,
    );
    expect(globalThis.fetch).toBe(nativeFetch);
  });
});

describe("resolveHttpSettings", () => {
  test("defaults: auto locally, replay in CI, in .forkit-http", () => {
    expect(resolveHttpSettings(undefined, undefined, {})).toEqual({
      mode: "auto",
      dir: ".forkit-http",
    });
    expect(resolveHttpSettings(undefined, undefined, { CI: "true" }).mode).toBe("replay");
    expect(resolveHttpSettings(undefined, undefined, { CI: "false" }).mode).toBe("auto");
  });

  test("env sets mode and dir; explicit options win", () => {
    const env = { FORKIT_HTTP: "record", FORKIT_HTTP_DIR: "/f", CI: "1" };
    expect(resolveHttpSettings(undefined, undefined, env)).toEqual({ mode: "record", dir: "/f" });
    expect(resolveHttpSettings("off", "/g", env)).toEqual({ mode: "off", dir: "/g" });
  });

  test("rejects an unknown env mode", () => {
    expect(() => resolveHttpSettings(undefined, undefined, { FORKIT_HTTP: "sometimes" })).toThrow(
      /not one of record, replay, auto, off/,
    );
  });
});
