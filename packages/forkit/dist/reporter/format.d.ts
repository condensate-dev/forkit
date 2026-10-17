import type { BridgeFillEvent, ForkBootEvent, ForkitEvent, GasSnapshotEvent, TestEndEvent, TestStartEvent, TxMinedEvent, TxRevertedEvent, TxSentEvent } from "../events.ts";
import { type Palette } from "./ansi.ts";
import { type RunLog, type TokenInfo } from "./serialize.ts";
export interface FormatOptions {
    /** ANSI colour. Default: {@link shouldColor} for stdout (off with `NO_COLOR`, in CI, off a TTY). */
    color?: boolean;
    /** A heading, e.g. the test file. */
    title?: string;
    /** Base for relative paths (the gas snapshot file). Default: `process.cwd()`. */
    cwd?: string;
    /**
     * Token symbols and decimals, by address (any chain) or `<chainId>:<address>`. They win over
     * what the run log read from the fork, e.g. when an offline fork cache cannot answer
     * `decimals()`.
     */
    tokens?: Readonly<Record<string, TokenInfo>>;
}
/** Everything a block renderer needs: colours, and names for addresses and tokens. */
export interface RenderContext {
    c: Palette;
    labels: Readonly<Record<string, string>>;
    tokens: Readonly<Record<string, TokenInfo>>;
    /** Chain names and native currency symbols, from `fork:boot` events. */
    chains: ReadonlyMap<number, {
        name: string;
        native: string;
    }>;
    cwd: string;
}
/** `1234567n` → `1,234,567`. */
export declare function groupDigits(value: bigint | number): string;
/**
 * A token amount for humans: grouped digits, `decimals` applied when known, at most 6 fraction
 * digits (more for a tiny amount, to show 4 significant ones), with `…` marking a cut. `signed`
 * adds `+` to positives.
 */
export declare function formatAmount(value: bigint, decimals?: number, signed?: boolean): string;
/** `0x1234…abcd`. */
export declare function shortHex(value: string): string;
/** `⛓ Base (8453) · block 21,000,000 · mainnet.base.org · cache hit (412 reads) · 812 ms`. */
export declare function formatBootLine(event: ForkBootEvent, ctx: RenderContext): string;
interface Activity {
    sent: TxSentEvent[];
    mined: TxMinedEvent[];
    reverted: TxRevertedEvent[];
    fills: BridgeFillEvent[];
}
/**
 * Net balance changes from receipts: every ERC-20 `Transfer` log, plus each transaction's native
 * `value` and the gas its sender paid. Keys: address → token key (`<chainId>:<token>` or
 * `<chainId>:native`) → delta.
 */
export declare function balanceChanges(mined: readonly TxMinedEvent[], sent: readonly TxSentEvent[]): Map<string, Map<string, bigint>>;
/** The balance table: one row per address, one column per token, signed and coloured deltas. */
export declare function formatBalanceTable(deltas: Map<string, Map<string, bigint>>, ctx: RenderContext): string[];
/** Split an error message into its head and the forkit trace it carries, if any. */
export declare function splitTrace(message: string): {
    head: string;
    trace?: string;
};
/** Colour a Foundry-style trace: tree and gas dim, calls cyan, reverts red, returns green. */
export declare function colorTrace(trace: string, c: Palette): string[];
/** Line diff of `expected` against `actual` (LCS), `-` for expected and `+` for actual. */
export declare function diffLines(expected: string, actual: string): {
    op: " " | "-" | "+";
    line: string;
}[];
/** `- expected` / `+ actual` lines; a line diff when either side spans several lines. */
export declare function formatDiff(expected: string, actual: string, c: Palette): string[];
/**
 * Why a test failed: the error's head, the Foundry-style trace of the revert behind it (from the
 * message, or from the `tx:reverted` event the error came from) and the expected-vs-actual diff.
 */
export declare function formatFailure(end: TestEndEvent, reverted: readonly TxRevertedEvent[], c: Palette): string[];
/** `⇄ across 8453:0x12ab…cd34:0 · Base → Arbitrum One · fill 0x… · fee 0.5 USDC · settled 999.5 USDC`. */
export declare function formatBridgeLine(fill: BridgeFillEvent, mined: readonly TxMinedEvent[], ctx: RenderContext): string;
/**
 * The gas table: per label, the committed value (the first measurement's `previous`) against the
 * latest measurement, with a coloured delta.
 */
export declare function formatGasTable(events: readonly GasSnapshotEvent[], ctx: RenderContext): string[];
/** One test: status, name, stats, balance table, bridge fills and, if it failed, why. */
export declare function formatTestBlock(start: TestStartEvent | undefined, end: TestEndEvent | undefined, activity: Activity, ctx: RenderContext): string[];
/**
 * Render run events (or a run log from `collectRun().snapshot()`, which adds token symbols and
 * decimals) as text for a terminal or a CI log. Plain events are labelled with this process's
 * labels, and token amounts stay in raw units.
 */
export declare function formatRun(input: readonly ForkitEvent[] | RunLog, options?: FormatOptions): string;
export {};
//# sourceMappingURL=format.d.ts.map