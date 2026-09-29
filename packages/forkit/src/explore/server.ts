/**
 * The `forkit explore` server: a read-only web UI over run records, on 127.0.0.1 only. The UI is
 * static files shipped in this package (`ui/`); it needs no network and loads nothing remote.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "./json.ts";
import type { RunRecord, RunSummary } from "./schema.ts";
import { isRunId, listRuns, readRun, readRunFile, summarize } from "./store.ts";

export interface ExploreServerOptions {
  /** The record directory (`.forkit`) whose runs to serve. */
  dir?: string;
  /** Run record files to serve besides (or instead of) `dir`'s runs. */
  files?: readonly string[];
  /** Port (default: a free one). */
  port?: number;
  /** Host to bind (default `127.0.0.1`). */
  host?: string;
}

export interface ExploreServer {
  /** `http://127.0.0.1:<port>/` */
  url: string;
  port: number;
  close(): Promise<void>;
}

const UI_DIR = new URL("./ui/", import.meta.url);

/** The static files, by URL path. Nothing else under ui/ is served. */
const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  head: boolean,
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": type,
    "content-length": Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown, head: boolean) =>
  send(res, status, "application/json; charset=utf-8", stringify(value), head);

/** A record file's run id, as the explorer serves it: its `id`, else its file name. */
export function fileRunId(file: string): string {
  try {
    const record = readRunFile(file);
    if (isRunId(record.id)) return record.id;
  } catch {
    // Reported when the run is opened.
  }
  return basename(file).replace(/\.json$/, "");
}

function fileRuns(files: readonly string[]): Map<string, string> {
  return new Map(files.map((file) => [fileRunId(file), file]));
}

/** Serve the explorer. Resolves once it listens. */
export async function startExploreServer(
  options: ExploreServerOptions = {},
): Promise<ExploreServer> {
  const host = options.host ?? "127.0.0.1";
  const files = fileRuns(options.files ?? []);
  const dir = options.dir;

  // A file given explicitly wins over a record-dir run with the same id, in the list as in
  // run(id), so the list never shows one run and opens another.
  const runs = (): RunSummary[] => {
    const list = (dir === undefined ? [] : listRuns(dir)).filter((r) => !files.has(r.id));
    for (const [id, file] of files) {
      try {
        list.push({ ...summarize(readRunFile(file)), id });
      } catch {
        // Not a run record.
      }
    }
    return list.sort((a, b) => b.startedAt - a.startedAt);
  };
  const run = (id: string): RunRecord | undefined => {
    const file = files.get(id);
    if (file !== undefined) return { ...readRunFile(file), id };
    return dir === undefined ? undefined : readRun(dir, id);
  };

  let port = 0;
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) {
      res.setHeader("allow", "GET, HEAD");
      sendJson(res, 405, { error: "read-only" }, false);
      return;
    }
    // DNS rebinding: a page on another origin that resolves to 127.0.0.1 must not read runs.
    const hostHeader = req.headers.host ?? "";
    if (
      hostHeader !== `127.0.0.1:${port}` &&
      hostHeader !== `localhost:${port}` &&
      hostHeader !== `${host}:${port}`
    ) {
      sendJson(res, 421, { error: "unexpected Host header" }, head);
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      const asset = ASSETS[path];
      if (asset !== undefined) {
        send(res, 200, asset.type, readFileSync(fileURLToPath(new URL(asset.file, UI_DIR))), head);
        return;
      }
      if (path === "/api/runs") {
        sendJson(res, 200, runs(), head);
        return;
      }
      const match = /^\/api\/runs\/([^/]+)$/.exec(path);
      if (match !== null) {
        const id = decodeURIComponent(match[1] as string);
        const record = isRunId(id) ? run(id) : undefined;
        if (record === undefined) sendJson(res, 404, { error: `no run ${id}` }, head);
        else sendJson(res, 200, record, head);
        return;
      }
      sendJson(res, 404, { error: "not found" }, head);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }, head);
    }
  };

  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}/`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
