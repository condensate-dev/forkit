/**
 * bun:test has no custom reporter API (`--reporter` takes only `junit` and `dots`), so this is a
 * preload instead: it collects run events for the whole `bun test` process (bun runs every file
 * in one process) and prints the forkit summary after the last test.
 *
 * ```toml
 * # bunfig.toml
 * [test]
 * preload = ["@condensate_dev/forkit/reporter/bun"]
 * ```
 *
 * or `bun test --preload @condensate_dev/forkit/reporter/bun`.
 */
import { afterAll } from "bun:test";
import { shouldColor } from "./ansi.ts";
import { collectRun } from "./collect.ts";
import { formatRun } from "./format.ts";

const collector = collectRun();

afterAll(async () => {
  const log = await collector.snapshot();
  collector.stop();
  if (log.events.length === 0) return;
  const text = formatRun(log, { title: "bun test", color: shouldColor(process.stdout) });
  process.stdout.write(`\n${text}\n`);
});
