/**
 * A recording JSON-RPC proxy that sits between anvil and the upstream RPC.
 *
 * anvil forks lazily: every account and storage slot a test touches is fetched from the upstream
 * on first use. At a pinned block those answers never change, so this proxy stores them on disk
 * and serves them locally on the next run. A warm run makes no network calls at all, which makes
 * fork tests fast, deterministic and safe to cache (turbo, actions/cache, or just commit the file).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { redactUrl } from "./rpc.ts";

/**
 * - `readwrite`: serve hits, fetch and record misses (default).
 * - `readonly`: serve hits, fetch misses, never write (CI that shares a restored cache).
 * - `offline`: serve hits, fail misses loudly; no network at all.
 * - `off`: no proxy; anvil talks to the upstream directly.
 */
export type CacheMode = "readwrite" | "readonly" | "offline" | "off";

export const CACHE_MODES: readonly CacheMode[] = ["readwrite", "readonly", "offline", "off"];

/** Env override for the cache mode, e.g. `FORKIT_CACHE=offline` in CI. */
export const CACHE_MODE_ENV = "FORKIT_CACHE";
/** Env override for the cache directory. */
export const CACHE_DIR_ENV = "FORKIT_CACHE_DIR";
/** Default cache directory, relative to the working directory. */
export const DEFAULT_CACHE_DIR = ".forkit-cache";

export interface RpcCacheStats {
  /** File the recording lives in. */
  readonly path: string;
  readonly mode: CacheMode;
  /** Requests answered from the recording. */
  readonly hits: number;
  /** Requests forwarded to the upstream (or refused, offline). */
  readonly misses: number;
  /** Entries in the recording. */
  readonly entries: number;
  /** Misses by JSON-RPC method: what made a run touch the network. */
  readonly missesByMethod: Readonly<Record<string, number>>;
}

export interface RpcCache {
  readonly url: string;
  stats(): RpcCacheStats;
  /** Stop serving and write new entries to disk. */
  close(): Promise<void>;
}

export interface RpcCacheOptions {
  upstream: string;
  chainId: number;
  blockNumber: bigint;
  mode: Exclude<CacheMode, "off">;
  dir: string;
  port: number;
  onWarn: (message: string) => void;
}

interface CacheFile {
  version: 1;
  chainId: number;
  blockNumber: string;
  /** Methods the upstream does not support (anvil probes some and falls back). */
  unsupported?: string[];
  entries: Record<string, unknown>;
}

type JsonRpcRequest = { jsonrpc?: string; id?: unknown; method: string; params?: unknown[] };
type JsonRpcResponse = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: unknown };

/** Methods whose answer is fixed once the block they name is fixed. */
const BLOCK_SCOPED = new Set([
  "eth_getStorageAt",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_getProof",
  "eth_getAccount",
  "eth_getAccountInfo",
  "eth_call",
  "eth_getBlockByNumber",
  "eth_getBlockReceipts",
]);
/**
 * Fee methods anvil reads once at boot. Not strictly block-scoped, but recording the first answer
 * with the pinned block makes replays deterministic.
 */
const PINNED_SNAPSHOT = new Set(["eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_blobBaseFee"]);
/**
 * Lookups by hash. anvil also asks the upstream about hashes of transactions it mined itself, and
 * the upstream answers null; offline, forkit answers null too instead of failing.
 */
const HASH_LOOKUPS = new Set([
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
]);
/**
 * Node-identity probes (anvil >= 1.8 asks whether its upstream is another anvil). Their answer
 * depends on the node, not the pinned block, and a replay has no node behind it, so the proxy
 * always presents a plain JSON-RPC endpoint: cold, warm and offline runs boot the same way.
 */
const NODE_PROBES = new Set(["anvil_nodeInfo", "anvil_metadata", "hardhat_metadata"]);
/** Methods whose answer never changes once it is non-null. */
const IMMUTABLE = new Set([
  "eth_chainId",
  "net_version",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
]);

function isHexQuantity(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) && value.length <= 18;
}

function isBlockHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Block hash (lowercase) -> block number, learned from recorded and fetched block headers. */
export type BlockHashes = ReadonlyMap<string, bigint>;

const NO_HASHES: BlockHashes = new Map();

/** Index of the parameter that names the block a request reads at. */
function blockParamIndex(request: JsonRpcRequest): number {
  const params = request.params ?? [];
  return request.method === "eth_getBlockByNumber" || request.method === "eth_getBlockReceipts"
    ? 0
    : params.length - 1;
}

/**
 * The block a request names: a number, or (anvil >= 1.8 pins fork reads by hash) the hash of a
 * block whose number is known. EIP-1898 objects (`{ blockNumber }` / `{ blockHash }`) too.
 */
function blockParam(request: JsonRpcRequest, hashes: BlockHashes): bigint | undefined {
  const candidate = (request.params ?? [])[blockParamIndex(request)];
  if (isHexQuantity(candidate)) return BigInt(candidate);
  if (isBlockHash(candidate)) return hashes.get(candidate.toLowerCase());
  if (typeof candidate === "object" && candidate !== null) {
    if ("blockNumber" in candidate && isHexQuantity(candidate.blockNumber)) {
      return BigInt(candidate.blockNumber);
    }
    if ("blockHash" in candidate && isBlockHash(candidate.blockHash)) {
      return hashes.get(candidate.blockHash.toLowerCase());
    }
  }
  return undefined;
}

/**
 * The block hash a block-scoped read names, when forkit does not know its number yet. anvil 1.8
 * can ask for state at a hash before (or concurrently with) fetching that block's header.
 */
export function unknownBlockHash(request: JsonRpcRequest, hashes: BlockHashes): string | undefined {
  if (!BLOCK_SCOPED.has(request.method)) return undefined;
  const candidate = (request.params ?? [])[blockParamIndex(request)];
  const hash =
    typeof candidate === "object" && candidate !== null && "blockHash" in candidate
      ? candidate.blockHash
      : candidate;
  if (!isBlockHash(hash) || hashes.has(hash.toLowerCase())) return undefined;
  return hash.toLowerCase();
}

export function isCacheable(
  request: JsonRpcRequest,
  pinned: bigint,
  hashes: BlockHashes = NO_HASHES,
): boolean {
  if (IMMUTABLE.has(request.method) || PINNED_SNAPSHOT.has(request.method)) return true;
  if (!BLOCK_SCOPED.has(request.method)) return false;
  const block = blockParam(request, hashes);
  return block !== undefined && block <= pinned;
}

/**
 * Stable key for a request. Block-scoped reads are keyed by block number whether they name the
 * block by number or by hash, so a recording made by one anvil version replays for another.
 */
export function cacheKey(request: JsonRpcRequest, hashes: BlockHashes = NO_HASHES): string {
  let params = request.params ?? [];
  if (BLOCK_SCOPED.has(request.method)) {
    const block = blockParam(request, hashes);
    if (block !== undefined) {
      params = [...params];
      params[blockParamIndex(request)] = `0x${block.toString(16)}`;
    }
  }
  return `${request.method}:${JSON.stringify(params).toLowerCase()}`;
}

/** The `hash -> number` pair a block header result carries, if it is one. */
export function blockHeaderHash(result: unknown): [string, bigint] | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const { hash, number } = result as { hash?: unknown; number?: unknown };
  if (!isBlockHash(hash) || !isHexQuantity(number)) return undefined;
  return [hash.toLowerCase(), BigInt(number)];
}

const ACCOUNT_FIELDS = {
  eth_getBalance: "balance",
  eth_getTransactionCount: "nonce",
  eth_getCode: "code",
} as const;

/**
 * Answer an account read from a recorded equivalent at the same block. anvil fetches each
 * account with `eth_getAccountInfo` and, racing it, the `eth_getBalance` / `eth_getTransactionCount`
 * / `eth_getCode` triple; which of them it sends varies run to run. Both carry the same facts, so a
 * replay serves whichever form it is asked for.
 */
export function deriveAccountRead(
  request: JsonRpcRequest,
  lookup: (request: JsonRpcRequest) => unknown,
): unknown {
  const params = request.params ?? [];
  if (request.method in ACCOUNT_FIELDS) {
    const info = lookup({ method: "eth_getAccountInfo", params });
    if (typeof info !== "object" || info === null) return undefined;
    return (info as Record<string, unknown>)[
      ACCOUNT_FIELDS[request.method as keyof typeof ACCOUNT_FIELDS]
    ];
  }
  if (request.method === "eth_getAccountInfo") {
    const [balance, nonce, code] = Object.keys(ACCOUNT_FIELDS).map((method) =>
      lookup({ method, params }),
    );
    if (balance === undefined || nonce === undefined || code === undefined) return undefined;
    return { balance, nonce, code };
  }
  return undefined;
}

/** `<dir>/<chainId>/<block>.json`. */
export function cacheFilePath(dir: string, chainId: number, blockNumber: bigint): string {
  return resolve(join(dir, String(chainId), `${blockNumber}.json`));
}

function readCacheFile(path: string): { entries: Record<string, unknown>; unsupported: string[] } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile>;
    if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
      return { entries: {}, unsupported: [] };
    }
    return { entries: parsed.entries, unsupported: parsed.unsupported ?? [] };
  } catch {
    return { entries: {}, unsupported: [] };
  }
}

function isUnsupportedMethodError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === -32601 ||
    (typeof message === "string" &&
      /method not (found|supported)|not supported|does not exist/i.test(message))
  );
}

function writeCacheFile(path: string, file: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true });
  // Sorted keys keep the file diff-friendly if it is committed.
  const entries = Object.fromEntries(
    Object.entries(file.entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...file, entries }, null, 1)}\n`);
  renameSync(tmp, path);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

async function forward(upstream: string, body: unknown): Promise<unknown> {
  let delay = 250;
  const backoff = async () => {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 8_000);
  };
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // Network errors are worth retrying: public RPCs drop connections under load.
      if (attempt >= 6) throw error;
      await backoff();
      continue;
    }
    if (RETRYABLE_STATUS.has(response.status) && attempt < 6) {
      await backoff();
      continue;
    }
    // Anything else is final: a 401 HTML page will not turn into JSON on the seventh try.
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`HTTP ${response.status}, not JSON-RPC: ${text.slice(0, 120)}`);
    }
  }
}

function asResponse(value: unknown, id: unknown): JsonRpcResponse {
  if (typeof value === "object" && value !== null) return { ...(value as JsonRpcResponse), id };
  return { jsonrpc: "2.0", id, error: { code: -32603, message: "forkit: bad upstream response" } };
}

export async function startRpcCache(options: RpcCacheOptions): Promise<RpcCache> {
  const path = cacheFilePath(options.dir, options.chainId, options.blockNumber);
  const recorded = readCacheFile(path);
  const entries = new Map(Object.entries(recorded.entries));
  const unsupported = new Set(recorded.unsupported);
  const freshUnsupported = new Set<string>();
  const fresh = new Map<string, unknown>();
  const inflight = new Map<string, Promise<JsonRpcResponse>>();
  const hashes = new Map<string, bigint>();
  const learnHash = (result: unknown): void => {
    const pair = blockHeaderHash(result);
    if (pair !== undefined && pair[1] <= options.blockNumber) hashes.set(pair[0], pair[1]);
  };
  for (const result of entries.values()) learnHash(result);
  let hits = 0;
  let misses = 0;
  let offlineMisses = 0;
  const missesByMethod: Record<string, number> = {};

  async function answer(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    // Learn an unknown hash's block number first (recorded, like any header), so the read is
    // keyed the same way whether or not the header happened to arrive before it.
    const hash = options.mode === "offline" ? undefined : unknownBlockHash(request, hashes);
    if (hash !== undefined) {
      await answer({
        jsonrpc: "2.0",
        id: null,
        method: "eth_getBlockByHash",
        params: [hash, false],
      });
    }
    const cacheable = isCacheable(request, options.blockNumber, hashes);
    const key = cacheable ? cacheKey(request, hashes) : undefined;
    if (unsupported.has(request.method) || NODE_PROBES.has(request.method)) {
      hits++;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `the method ${request.method} does not exist/is not available`,
        },
      };
    }
    if (key !== undefined && entries.has(key)) {
      hits++;
      return { jsonrpc: "2.0", id, result: entries.get(key) };
    }
    const derived =
      key === undefined
        ? undefined
        : deriveAccountRead(request, (r) => entries.get(cacheKey(r, hashes)));
    if (derived !== undefined) {
      hits++;
      return { jsonrpc: "2.0", id, result: derived };
    }
    misses++;
    missesByMethod[request.method] = (missesByMethod[request.method] ?? 0) + 1;
    if (process.env.FORKIT_DEBUG) {
      console.error(`forkit cache miss: ${request.method} ${JSON.stringify(request.params ?? [])}`);
    }
    if (options.mode === "offline") {
      if (HASH_LOOKUPS.has(request.method)) return { jsonrpc: "2.0", id, result: null };
      offlineMisses++;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: `forkit: offline and ${request.method} is not in the fork cache (${path}). Run once with FORKIT_CACHE=readwrite and network access to record it.`,
        },
      };
    }
    if (key === undefined) return asResponse(await forward(options.upstream, request), id);
    const pending =
      inflight.get(key) ??
      (async () => {
        const response = asResponse(await forward(options.upstream, request), id);
        if (response.error !== undefined && isUnsupportedMethodError(response.error)) {
          unsupported.add(request.method);
          freshUnsupported.add(request.method);
        } else if (
          response.error === undefined &&
          response.result !== null &&
          response.result !== undefined
        ) {
          entries.set(key, response.result);
          fresh.set(key, response.result);
          learnHash(response.result);
        }
        return response;
      })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return { ...(await pending), id };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const reply = Array.isArray(payload)
      ? await Promise.all((payload as JsonRpcRequest[]).map((r) => answer(r)))
      : await answer(payload as JsonRpcRequest);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: `forkit: upstream ${redactUrl(options.upstream)} failed: ${String(error)}`,
          },
        }),
      );
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(options.port, "127.0.0.1", () => ok());
  });

  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${options.port}`,
    stats: () => ({
      path,
      mode: options.mode,
      hits,
      misses,
      entries: entries.size,
      missesByMethod: { ...missesByMethod },
    }),
    close() {
      closed ??= (async () => {
        await new Promise<void>((ok) => {
          server.close(() => ok());
          server.closeAllConnections();
        });
        if (options.mode === "readwrite" && (fresh.size > 0 || freshUnsupported.size > 0)) {
          // Merge with whatever parallel runs wrote meanwhile.
          const onDisk = readCacheFile(path);
          writeCacheFile(path, {
            version: 1,
            chainId: options.chainId,
            blockNumber: options.blockNumber.toString(),
            unsupported: [...new Set([...onDisk.unsupported, ...freshUnsupported])].sort(),
            entries: { ...onDisk.entries, ...Object.fromEntries(fresh) },
          });
        }
        if (offlineMisses > 0) {
          options.onWarn(
            `forkit: ${offlineMisses} request(s) missed the offline fork cache ${path}; record them with FORKIT_CACHE=readwrite.`,
          );
        }
      })();
      return closed;
    },
  };
}

/** Resolve the cache mode and directory from options, then env, then defaults. */
export function resolveCacheSettings(
  mode: CacheMode | undefined,
  dir: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { mode: CacheMode; dir: string } {
  const envMode = env[CACHE_MODE_ENV];
  let resolvedMode: CacheMode = mode ?? "readwrite";
  if (mode === undefined && envMode !== undefined && envMode !== "") {
    if (!(CACHE_MODES as readonly string[]).includes(envMode)) {
      throw new Error(
        `forkit: ${CACHE_MODE_ENV}=${envMode} is not one of ${CACHE_MODES.join(", ")}`,
      );
    }
    resolvedMode = envMode as CacheMode;
  }
  return { mode: resolvedMode, dir: dir ?? env[CACHE_DIR_ENV] ?? DEFAULT_CACHE_DIR };
}
