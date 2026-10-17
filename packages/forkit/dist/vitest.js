/**
 * vitest adapter: `describeFork` boots one fork per suite and isolates every test with
 * snapshot/revert; `itFork` hands each test that fork.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, TestRunner } from "vitest";
import { createForkAdapter } from "./adapter.js";
// The suite being collected, so an itFork outside any describeFork fails at collection time.
// `TestRunner.getCurrentSuite` is public from vitest 5; without it, that error comes at run time.
const getCurrentSuite = TestRunner
    .getCurrentSuite;
export const { describeFork, itFork } = createForkAdapter({
    describe: (name, body) => describe(name, body),
    it: (name, fn, timeoutMs) => it(name, fn, timeoutMs),
    hooks: { beforeAll, afterAll, beforeEach, afterEach },
    ...(getCurrentSuite === undefined ? {} : { currentSuite: () => getCurrentSuite().suite }),
});
//# sourceMappingURL=vitest.js.map