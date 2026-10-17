/** Render a decoded ABI value for humans: labels for addresses, bigints as decimals. */
export declare function formatValue(value: unknown): string;
export declare function formatArgs(args: readonly unknown[] | undefined): string;
/** Deep equality for decoded ABI values: bigint-aware, addresses and hex case-insensitive. */
export declare function abiEqual(a: unknown, b: unknown): boolean;
//# sourceMappingURL=format.d.ts.map