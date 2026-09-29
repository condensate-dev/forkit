/**
 * vitest setup file for `@condensate/forkit/reporter`: collects run events in each worker and
 * hands them to the reporter in the main process through task metadata. After every test (and
 * after the file) it attaches the events since the last hand-off, as bigint-safe JSON, to the
 * test's (or file's) `meta.forkit`.
 *
 * ```ts
 * // vitest.config.ts
 * test: {
 *   setupFiles: ["@condensate/forkit/reporter/setup"],
 *   reporters: ["default", "@condensate/forkit/reporter"],
 * }
 * ```
 */
import { afterAll, afterEach } from "vitest";
import { collectRun, type RunCollector } from "./collect.ts";
import { META_KEY } from "./meta.ts";
import { serializeRunLog } from "./serialize.ts";

// One collector per worker module graph, even if the setup file runs again (e.g. `isolate: false`).
const GLOBAL = Symbol.for("@condensate/forkit/reporter/collector");
const store = globalThis as { [GLOBAL]?: RunCollector };
const collector = store[GLOBAL] ?? collectRun();
store[GLOBAL] = collector;

async function handOff(meta: object): Promise<void> {
  const log = await collector.drain();
  if (log.events.length > 0) (meta as Record<string, unknown>)[META_KEY] = serializeRunLog(log);
}

afterEach(async ({ task }) => {
  await handOff(task.meta);
});

/** The file suite among a hook's arguments: it is the one with `tasks` and `meta`. */
function suiteOf(args: readonly unknown[]): { meta: object } | undefined {
  return args.find(
    (a): a is { meta: object } =>
      typeof a === "object" && a !== null && "tasks" in a && "meta" in a,
  );
}

// vitest 5 passes suite hooks (fixtures, suite) and requires a destructured first parameter;
// vitest 3 and 4 pass (suite). A bound function has no parameter list for vitest to parse, so
// one hook serves every version and finds the suite among its arguments.
const fileDone = async (...args: unknown[]) => {
  const suite = suiteOf(args);
  if (suite !== undefined) await handOff(suite.meta);
};
afterAll(fileDone.bind(undefined));
