/**
 * bun:test has no custom reporter API (`--reporter` takes only `junit` and `dots`), so this is a
 * preload instead: it collects run events for the whole `bun test` process (bun runs every file
 * in one process) and prints the forkit summary after the last test.
 *
 * ```toml
 * # bunfig.toml
 * [test]
 * preload = ["@condensate/forkit/reporter/bun"]
 * ```
 *
 * or `bun test --preload @condensate/forkit/reporter/bun`.
 */
import { afterAll } from "bun:test";
import { shouldColor } from "./ansi.js";
import { collectRun } from "./collect.js";
import { formatRun } from "./format.js";
const collector = collectRun();
afterAll(async () => {
    const log = await collector.snapshot();
    collector.stop();
    if (log.events.length === 0)
        return;
    const text = formatRun(log, { title: "bun test", color: shouldColor(process.stdout) });
    process.stdout.write(`\n${text}\n`);
});
//# sourceMappingURL=bun.js.map