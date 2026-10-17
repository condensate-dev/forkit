/**
 * Whether `error` means the contract does not implement the function it was called with: the
 * call reverted, or it answered nothing decodable. A request the node failed (a JSON-RPC error
 * other than a revert, such as an offline fork cache miss) is neither.
 */
export declare function isMissingFunction(error: unknown): boolean;
/**
 * `read()`, or `undefined` when the contract does not implement the function. Anything else (the
 * RPC is down, the fork cache missed offline) still throws: a silent `undefined` there would pick
 * the wrong EIP-712 domain, or skip the check that catches one.
 */
export declare function optional<T>(read: () => Promise<T>): Promise<T | undefined>;
//# sourceMappingURL=read.d.ts.map