/**
 * `@condensate/forkit/reporter`: readable run output in any runner.
 *
 * - vitest: `reporters: ["default", "@condensate/forkit/reporter"]` plus the setup file
 *   `@condensate/forkit/reporter/setup` (see {@link ForkitReporter}).
 * - bun:test: preload `@condensate/forkit/reporter/bun`.
 * - jest, node:test: `const run = collectRun()` in the test file, then
 *   `console.log(formatRun(await run.snapshot()))` in `afterAll`/`after`.
 */
import { ForkitReporter } from "./vitest.js";
export { palette, shouldColor, stripAnsi } from "./ansi.js";
export { collectRun, lookupToken } from "./collect.js";
export { balanceChanges, diffLines, formatAmount, formatBalanceTable, formatBootLine, formatBridgeLine, formatDiff, formatFailure, formatGasTable, formatRun, formatTestBlock, } from "./format.js";
export { META_KEY } from "./meta.js";
export { mergeRunLogs, parseRunLog, serializeRunLog, } from "./serialize.js";
export { ForkitReporter, moduleLog, testEvents } from "./vitest.js";
/** vitest loads a reporter given by module path from its default export. */
export default ForkitReporter;
//# sourceMappingURL=index.js.map