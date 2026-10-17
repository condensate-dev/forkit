/**
 * The vitest reporter. Pair it with the setup file, which collects run events in the workers:
 *
 * ```ts
 * // vitest.config.ts
 * test: {
 *   setupFiles: ["@condensate/forkit/reporter/setup"],
 *   reporters: ["default", "@condensate/forkit/reporter"],
 * }
 * ```
 *
 * After the run it prints, per test file: fork boot lines, each test's txs, gas and balance
 * changes, failure traces with an expected-vs-actual diff, bridge fills, and the gas snapshot diff.
 * It imports nothing from vitest at run time, only types.
 */
import type { TestCase, TestModule, Vitest } from "vitest/node";
import type { ForkitEvent } from "../events.ts";
import { type RunLog, type TokenInfo } from "./serialize.ts";
export interface ForkitReporterOptions {
    /** ANSI colour. Default: on for a TTY, off with `NO_COLOR`, in CI or when piped. */
    color?: boolean;
    /** Where to write. Default: vitest's logger (stdout). */
    write?: (text: string) => void;
    /** Token symbols and decimals, by address or `<chainId>:<address>` (see `FormatOptions`). */
    tokens?: Readonly<Record<string, TokenInfo>>;
}
/**
 * A test's events in the shape `formatRun` expects: tests written with `itFork` bring their own
 * `test:start`/`test:end`; for any other test that used a fork, the reporter adds them from
 * vitest's result. vitest's failure (with its actual/expected) fills in what `test:end` lacks.
 */
export declare function testEvents(test: TestCase, events: readonly ForkitEvent[]): ForkitEvent[];
/** The events of one test file, in run order: per-test hand-offs, then the file's own. */
export declare function moduleLog(module: TestModule): RunLog | undefined;
/** vitest reporter printing forkit's run summary after the run. Use with the setup file. */
export declare class ForkitReporter {
    #private;
    constructor(options?: ForkitReporterOptions);
    onInit(vitest: Vitest): void;
    onTestRunEnd(modules: ReadonlyArray<TestModule>): void;
}
//# sourceMappingURL=vitest.d.ts.map