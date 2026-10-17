/** Bundler RPC methods that submit a user operation. */
export declare const SEND_METHODS: ReadonlySet<string>;
export interface JsonRpcRequest {
    id?: unknown;
    method?: unknown;
    params?: unknown;
}
export interface JsonRpcReply {
    id?: unknown;
    result?: unknown;
    error?: unknown;
}
/** The requests in a JSON-RPC payload: one request or a batch. */
export declare function requestsIn(payload: unknown): JsonRpcRequest[];
/** The replies in a JSON-RPC reply body: one reply or a batch. */
export declare function repliesIn(reply: unknown): JsonRpcReply[];
/** True if the JSON-RPC payload (one request or a batch) submits a user operation. */
export declare function containsSend(payload: unknown): boolean;
/** JSON-RPC error replies for every request in `payload`, shaped like the payload. */
export declare function errorReply(payload: unknown, message: string): unknown;
/** A local JSON-RPC forwarder. */
export interface RpcProxy {
    readonly url: string;
    close(): Promise<void>;
}
export interface RpcProxyOptions {
    upstream: string;
    port: number;
    /**
     * Runs before a request is forwarded. Throwing answers every request in it with a JSON-RPC
     * error carrying the message, and nothing is forwarded.
     */
    before?: (payload: unknown) => Promise<void>;
    /** Runs once the upstream answered, before the reply goes back (it may delay the reply). */
    after?: (payload: unknown, reply: unknown) => Promise<void>;
    /** Requests for which this is true run one at a time, `before` through the upstream's answer. */
    serialize?: (payload: unknown) => boolean;
}
/**
 * Start a forwarder. Bodies go upstream unchanged and replies come back unchanged; the hooks only
 * observe, delay or refuse.
 */
export declare function startRpcProxy(options: RpcProxyOptions): Promise<RpcProxy>;
/**
 * The highest block number in replies to block queries (`eth_blockNumber`, `eth_getBlockBy*`),
 * or `undefined` if there is none. Used to learn what alto has seen of the chain.
 */
export declare function highestBlockIn(payload: unknown, reply: unknown): bigint | undefined;
//# sourceMappingURL=proxy.d.ts.map