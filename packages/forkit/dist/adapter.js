import { ForkitError } from "./errors.js";
import { emitForkitEvent } from "./events.js";
import { formatValue } from "./format.js";
import { createForkSuite, } from "./suite.js";
/** A failed expectation's actual and expected values, rendered, when the error carries both. */
function expectation(error) {
    if (typeof error !== "object" || error === null)
        return {};
    if (!("actual" in error) || !("expected" in error))
        return {};
    const { actual, expected } = error;
    if (actual === undefined && expected === undefined)
        return {};
    const render = (value) => (typeof value === "string" ? value : formatValue(value));
    return { actual: render(actual), expected: render(expected) };
}
const OUTSIDE = "forkit: itFork must be called inside a describeFork body.";
let lastTestId = 0;
export function createForkAdapter(runner) {
    // itFork resolves its fork when the test runs, from a stack that each describeFork's
    // beforeEach pushes and afterEach pops. Hooks run outer to inner and back, so the top is the
    // nearest enclosing describeFork, whatever order the runner collects nested `describe`
    // bodies in: jest and node:test run them inside the parent's body, but vitest and bun:test run
    // them after it returns, when a collection-time stack would already be empty.
    const running = [];
    // Only for early errors: the describeFork bodies being collected, and (vitest) their suites.
    const collecting = [];
    const suites = new WeakSet();
    const insideDescribeFork = () => {
        if (collecting.length > 0)
            return true;
        if (runner.currentSuite === undefined)
            return undefined; // can't tell yet; checked at run time
        for (let suite = runner.currentSuite(); suite !== undefined; suite = suite.suite) {
            if (suites.has(suite))
                return true;
        }
        return false;
    };
    return {
        describeFork(name, targets, body, options) {
            runner.describe(name, () => {
                const handle = createForkSuite(targets, runner.hooks, options);
                runner.hooks.beforeEach(() => {
                    running.push({ handle, suite: name });
                });
                runner.hooks.afterEach(() => {
                    running.pop();
                });
                const suite = runner.currentSuite?.();
                if (suite !== undefined)
                    suites.add(suite);
                collecting.push(handle);
                try {
                    body(handle);
                }
                finally {
                    collecting.pop();
                }
            });
        },
        itFork(name, fn, timeoutMs) {
            if (insideDescribeFork() === false)
                throw new ForkitError(OUTSIDE);
            runner.it(name, async () => {
                const current = running.at(-1);
                if (current === undefined)
                    throw new ForkitError(OUTSIDE);
                const testId = ++lastTestId;
                const started = Date.now();
                const base = { testId, suite: current.suite, name };
                emitForkitEvent({ type: "test:start", ts: started, ...base });
                try {
                    await fn(current.handle);
                }
                catch (error) {
                    emitForkitEvent({
                        type: "test:end",
                        ts: Date.now(),
                        ...base,
                        status: "fail",
                        durationMs: Date.now() - started,
                        error: error instanceof Error ? error.message : String(error),
                        ...expectation(error),
                    });
                    throw error;
                }
                emitForkitEvent({
                    type: "test:end",
                    ts: Date.now(),
                    ...base,
                    status: "pass",
                    durationMs: Date.now() - started,
                });
            }, timeoutMs);
        },
    };
}
//# sourceMappingURL=adapter.js.map