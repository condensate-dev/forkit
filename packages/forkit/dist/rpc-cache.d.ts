/**
 * - `readwrite`: serve hits, fetch and record misses (default).
 * - `readonly`: serve hits, fetch misses, never write (CI that shares a restored cache).
 * - `offline`: serve hits, fail misses loudly; no network at all. A miss fails the request, and
 *   `close()` rejects with a {@link ForkCacheMissError} that lists every miss.
 * - `off`: no proxy; anvil talks to the upstream directly.
 */
export type CacheMode = "readwrite" | "readonly" | "offline" | "off";
export declare const CACHE_MODES: readonly CacheMode[];
/** Env override for the cache mode, e.g. `FORKIT_CACHE=offline` in CI. */
export declare const CACHE_MODE_ENV = "FORKIT_CACHE";
/** Env override for the cache directory. */
export declare const CACHE_DIR_ENV = "FORKIT_CACHE_DIR";
/** Default cache directory, relative to the working directory. */
export declare const DEFAULT_CACHE_DIR = ".forkit-cache";
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
    /**
     * Stop serving and write new entries to disk. Offline, it then rejects with a
     * {@link ForkCacheMissError} if any request missed the recording.
     */
    close(): Promise<void>;
}
export interface RpcCacheOptions {
    upstream: string;
    chainId: number;
    blockNumber: bigint;
    mode: Exclude<CacheMode, "off">;
    dir: string;
    port: number;
}
type JsonRpcRequest = {
    jsonrpc?: string;
    id?: unknown;
    method: string;
    params?: unknown[];
};
/** Block hash (lowercase) -> block number, learned from recorded and fetched block headers. */
export type BlockHashes = ReadonlyMap<string, bigint>;
/**
 * The block hash a block-scoped read names, when forkit does not know its number yet. anvil 1.8
 * can ask for state at a hash before (or concurrently with) fetching that block's header.
 */
export declare function unknownBlockHash(request: JsonRpcRequest, hashes: BlockHashes): string | undefined;
export declare function isCacheable(request: JsonRpcRequest, pinned: bigint, hashes?: BlockHashes): boolean;
/**
 * Stable key for a request. Block-scoped reads are keyed by block number whether they name the
 * block by number or by hash, so a recording made by one anvil version replays for another.
 */
export declare function cacheKey(request: JsonRpcRequest, hashes?: BlockHashes): string;
/** The `hash -> number` pair a block header result carries, if it is one. */
export declare function blockHeaderHash(result: unknown): [string, bigint] | undefined;
/**
 * Answer an account read from a recorded equivalent at the same block. anvil fetches each
 * account with `eth_getAccountInfo` and, racing it, the `eth_getBalance` / `eth_getTransactionCount`
 * / `eth_getCode` triple; which of them it sends varies run to run. Both carry the same facts, so a
 * replay serves whichever form it is asked for.
 */
export declare function deriveAccountRead(request: JsonRpcRequest, lookup: (request: JsonRpcRequest) => unknown): unknown;
/** `<dir>/<chainId>/<block>.json`. */
export declare function cacheFilePath(dir: string, chainId: number, blockNumber: bigint): string;
export declare function startRpcCache(options: RpcCacheOptions): Promise<RpcCache>;
/** Resolve the cache mode and directory from options, then env, then defaults. */
export declare function resolveCacheSettings(mode: CacheMode | undefined, dir: string | undefined, env?: Readonly<Record<string, string | undefined>>): {
    mode: CacheMode;
    dir: string;
};
export {};
//# sourceMappingURL=rpc-cache.d.ts.map