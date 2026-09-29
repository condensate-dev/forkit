/**
 * `@condensate/forkit/reporter`: readable run output in any runner.
 *
 * - vitest: `reporters: ["default", "@condensate/forkit/reporter"]` plus the setup file
 *   `@condensate/forkit/reporter/setup` (see {@link ForkitReporter}).
 * - bun:test: preload `@condensate/forkit/reporter/bun`.
 * - jest, node:test: `const run = collectRun()` in the test file, then
 *   `console.log(formatRun(await run.snapshot()))` in `afterAll`/`after`.
 */
import { ForkitReporter } from "./vitest.ts";

export { type Palette, palette, shouldColor, stripAnsi } from "./ansi.ts";
export { collectRun, lookupToken, type RunCollector } from "./collect.ts";
export {
  balanceChanges,
  diffLines,
  type FormatOptions,
  formatAmount,
  formatBalanceTable,
  formatBootLine,
  formatBridgeLine,
  formatDiff,
  formatFailure,
  formatGasTable,
  formatRun,
  formatTestBlock,
  type RenderContext,
} from "./format.ts";
export { META_KEY } from "./meta.ts";
export {
  mergeRunLogs,
  parseRunLog,
  type RunLog,
  serializeRunLog,
  type TokenInfo,
} from "./serialize.ts";
export { ForkitReporter, type ForkitReporterOptions, moduleLog, testEvents } from "./vitest.ts";

/** vitest loads a reporter given by module path from its default export. */
export default ForkitReporter;
