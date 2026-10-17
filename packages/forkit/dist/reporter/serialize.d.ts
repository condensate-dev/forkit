/**
 * A run log, and its JSON form. Events cross process boundaries (vitest workers to the reporter
 * in the main process) as JSON, where bigints travel as `{ "$bigint": "123" }`.
 */
import type { ForkitEvent } from "../events.ts";
/** What the ERC-20 at an address calls itself. */
export interface TokenInfo {
    symbol?: string;
    decimals?: number;
}
/** Events plus what is needed to render them away from the process that emitted them. */
export interface RunLog {
    events: ForkitEvent[];
    /** Labels (see `label()`) of the addresses in `events`, by lowercase address. */
    labels: Record<string, string>;
    /** ERC-20 metadata by `<chainId>:<lowercase address>`. */
    tokens: Record<string, TokenInfo>;
}
export declare const tokenKey: (chainId: number, address: string) => string;
/** JSON for a run log, bigint-safe. */
export declare function serializeRunLog(log: RunLog): string;
/** The inverse of {@link serializeRunLog}. */
export declare function parseRunLog(text: string): RunLog;
/** Concatenate run logs in order; later labels and token metadata win. */
export declare function mergeRunLogs(logs: readonly RunLog[]): RunLog;
//# sourceMappingURL=serialize.d.ts.map