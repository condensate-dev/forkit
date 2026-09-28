/**
 * jest adapter: `describeFork` boots one fork per suite and isolates every test with
 * snapshot/revert; `itFork` hands each test that fork.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "@jest/globals";
import { createForkAdapter } from "./adapter.ts";

export type { ForkSuiteOptions, ForkTargets } from "./suite.ts";

export const { describeFork, itFork } = createForkAdapter({
  describe: (name, body) => describe(name, body),
  it: (name, fn, timeoutMs) => it(name, fn, timeoutMs),
  hooks: { beforeAll, afterAll, beforeEach, afterEach },
});
