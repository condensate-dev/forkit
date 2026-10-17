import { shouldColor } from "./ansi.js";
import { formatRun } from "./format.js";
import { META_KEY } from "./meta.js";
import { mergeRunLogs, parseRunLog } from "./serialize.js";
function logOf(meta) {
    const raw = meta[META_KEY];
    if (typeof raw !== "string")
        return undefined;
    try {
        return parseRunLog(raw);
    }
    catch {
        return undefined;
    }
}
function render(value) {
    if (value === undefined)
        return undefined;
    return typeof value === "string" ? value : JSON.stringify(value);
}
let syntheticId = 0;
/**
 * A test's events in the shape `formatRun` expects: tests written with `itFork` bring their own
 * `test:start`/`test:end`; for any other test that used a fork, the reporter adds them from
 * vitest's result. vitest's failure (with its actual/expected) fills in what `test:end` lacks.
 */
export function testEvents(test, events) {
    const result = test.result();
    const failed = result.state === "failed";
    const error = failed
        ? result.errors?.[0]
        : undefined;
    const fromVitest = {};
    if (error !== undefined) {
        fromVitest.error = error.message ?? "failed";
        const actual = render(error.actual);
        const expected = render(error.expected);
        if (actual !== undefined && expected !== undefined) {
            fromVitest.actual = actual;
            fromVitest.expected = expected;
        }
    }
    const hasStart = events.some((e) => e.type === "test:start");
    if (hasStart) {
        return events.map((e) => e.type === "test:end" && e.status === "fail"
            ? {
                ...e,
                ...(e.actual === undefined && fromVitest.actual !== undefined
                    ? { actual: fromVitest.actual, expected: fromVitest.expected }
                    : {}),
            }
            : e);
    }
    if (events.every((e) => e.type === "fork:boot"))
        return [...events];
    // A plain `it`/`test` that used a fork: bracket its own events (boots stay in front).
    const boots = events.filter((e) => e.type === "fork:boot");
    const rest = events.filter((e) => e.type !== "fork:boot");
    // The file is the heading already; a top-level test has no suite to show.
    const suite = test.parent.type === "module" ? "" : test.parent.fullName;
    const testId = --syntheticId;
    const ts = rest[0]?.ts ?? Date.now();
    const duration = test.diagnostic()?.duration ?? 0;
    const end = {
        type: "test:end",
        ts: rest.at(-1)?.ts ?? ts,
        testId,
        suite,
        name: test.name,
        status: failed ? "fail" : "pass",
        durationMs: duration,
        ...fromVitest,
    };
    return [...boots, { type: "test:start", ts, testId, suite, name: test.name }, ...rest, end];
}
/** The events of one test file, in run order: per-test hand-offs, then the file's own. */
export function moduleLog(module) {
    const logs = [];
    for (const test of module.children.allTests()) {
        const log = logOf(test.meta());
        if (log !== undefined)
            logs.push({ ...log, events: testEvents(test, log.events) });
    }
    const own = logOf(module.meta());
    if (own !== undefined)
        logs.push(own);
    return logs.length === 0 ? undefined : mergeRunLogs(logs);
}
/** vitest reporter printing forkit's run summary after the run. Use with the setup file. */
export class ForkitReporter {
    #vitest;
    #options;
    constructor(options = {}) {
        this.#options = options;
    }
    onInit(vitest) {
        this.#vitest = vitest;
    }
    onTestRunEnd(modules) {
        const color = this.#options.color ?? shouldColor(process.stdout);
        const blocks = [];
        for (const module of modules) {
            const log = moduleLog(module);
            if (log === undefined)
                continue;
            blocks.push(formatRun(log, {
                color,
                title: module.relativeModuleId,
                cwd: this.#vitest?.config.root ?? process.cwd(),
                ...(this.#options.tokens === undefined ? {} : { tokens: this.#options.tokens }),
            }));
        }
        if (blocks.length === 0)
            return;
        const text = `\n${blocks.join("\n\n")}\n`;
        if (this.#options.write !== undefined)
            this.#options.write(text);
        else if (this.#vitest !== undefined)
            this.#vitest.logger.log(text);
        else
            process.stdout.write(`${text}\n`);
    }
}
//# sourceMappingURL=vitest.js.map