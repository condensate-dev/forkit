/**
 * node:test adapter: `describeFork` boots one fork per suite and isolates every test with
 * snapshot/revert; `itFork` hands each test that fork.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createForkAdapter } from "./adapter.js";
// node:test takes `{ timeout }` where the other runners take a number.
const withTimeout = (register) => (fn, timeoutMs) => register(fn, timeoutMs === undefined ? {} : { timeout: timeoutMs });
export const { describeFork, itFork } = createForkAdapter({
    describe: (name, body) => {
        describe(name, body);
    },
    it: (name, fn, timeoutMs) => {
        it(name, timeoutMs === undefined ? {} : { timeout: timeoutMs }, fn);
    },
    hooks: {
        beforeAll: withTimeout(before),
        afterAll: withTimeout(after),
        beforeEach: withTimeout(beforeEach),
        afterEach: withTimeout(afterEach),
    },
});
//# sourceMappingURL=node.js.map