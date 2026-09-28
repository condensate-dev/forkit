/**
 * vitest adapter: `describeFork` boots one fork per suite and isolates every test with
 * snapshot/revert; `itFork` hands each test that fork.
 */
import type { Chain } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, TestRunner } from "vitest";
import { ForkitError } from "./errors.ts";
import { createForkSuite, type ForkSuiteOptions } from "./suite.ts";
import type { Fork, ForkTarget } from "./types.ts";

// The fork of each describeFork suite. vitest runs a nested `describe` factory after its
// parent's factory has returned, so a push/pop stack would be empty by then; itFork instead walks
// up from the suite being collected to the nearest describeFork. Chain types are erased here;
// itFork restores them.
type SuiteTask = { suite?: SuiteTask };
const forks = new WeakMap<object, object>();
// Fallback for vitest builds without `TestRunner.getCurrentSuite` (it is public from vitest 5):
// the enclosing describeFork bodies, which covers itFork directly inside describeFork.
const active: object[] = [];

function currentSuite(): SuiteTask | undefined {
  const getCurrentSuite = (TestRunner as { getCurrentSuite?: () => { suite?: SuiteTask } })
    .getCurrentSuite;
  return getCurrentSuite?.().suite;
}

/**
 * A `describe` block with a fork: booted before the first test, reverted to a clean snapshot
 * after every test, stopped after the last. `body` receives the fork handle.
 */
export function describeFork<TChain extends Chain>(
  name: string,
  target: ForkTarget<TChain>,
  body: (fork: Fork<TChain>) => void,
  options?: ForkSuiteOptions,
): void {
  describe(name, () => {
    const handle = createForkSuite(target, { beforeAll, afterAll, beforeEach, afterEach }, options);
    const suite = currentSuite();
    if (suite !== undefined) forks.set(suite, handle);
    active.push(handle);
    try {
      body(handle);
    } finally {
      active.pop();
    }
  });
}

/**
 * An `it` inside {@link describeFork} (directly or in a nested `describe`) that receives the
 * nearest enclosing fork. Pass the chain type
 * (`itFork<typeof base>(...)`) for a typed client; the `describeFork` body's handle is always
 * precisely typed.
 */
export function itFork<TChain extends Chain = Chain>(
  name: string,
  fn: (fork: Fork<TChain>) => Promise<void> | void,
  timeoutMs?: number,
): void {
  let handle: object | undefined;
  for (
    let suite = currentSuite();
    suite !== undefined && handle === undefined;
    suite = suite.suite
  ) {
    handle = forks.get(suite);
  }
  handle ??= active.at(-1);
  if (handle === undefined) {
    throw new ForkitError("forkit: itFork must be called inside a describeFork body.");
  }
  it(name, () => fn(handle as Fork<TChain>), timeoutMs);
}
