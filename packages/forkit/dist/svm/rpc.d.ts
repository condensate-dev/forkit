/**
 * JSON with bigints as plain JSON numbers: surfpool reads lamports, token amounts, slots and
 * timestamps as u64, and a JS number loses precision above 2^53.
 */
export declare function stringifyWithBigints(value: unknown): string;
/**
 * One JSON-RPC call over HTTP. forkit/svm uses it for surfpool's own `surfnet_*` methods, which
 * `@solana/kit`'s typed RPC does not know; everything else goes through the handle's `rpc`.
 */
export declare function jsonRpc<T>(url: string, method: string, params?: readonly unknown[], signal?: AbortSignal): Promise<T>;
//# sourceMappingURL=rpc.d.ts.map