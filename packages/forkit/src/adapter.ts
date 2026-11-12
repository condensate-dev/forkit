/**
 * Builds `describeFork` / `itFork` for one test runner from its `describe`, `it` and hooks. Each
 * runner adapter (`@condensate_dev/forkit/vitest`, `/bun`, `/jest`, `/node`) is this plus imports.
 */
import type { Chain } from "viem";
import { ForkitError } from "./errors.ts";
import { emitForkitEvent } from "./events.ts";
import { formatValue } from "./format.ts";
import {
  createForkSuite,
  type ForkSuiteOptions,
  type ForkTargets,
  type SuiteHooks,
} from "./suite.ts";
import type { Fork } from "./types.ts";

type TestFn = () => Promise<void> | void;

/** A suite in the runner's tree, linked to its parent (vitest's shape). */
export interface SuiteNode {
  suite?: SuiteNode | undefined;
}

/** The parts of a test runner an adapter needs. */
export interface RunnerApi {
  describe(name: string, body: () => void): void;
  it(name: string, fn: TestFn, timeoutMs?: number): void;
  hooks: SuiteHooks;
  /**
   * The suite being collected (vitest). Optional: it only lets an `itFork` placed outside any
   * describeFork fail at collection time instead of when it runs.
   */
  currentSuite?(): SuiteNode | undefined;
}

export interface ForkAdapter {
  /**
   * A `describe` block with a fork: booted before the first test, every chain reverted to a clean
   * snapshot after every test, stopped after the last. `body` receives the fork handle. Pass an
   * array of targets for a multi-chain fork; the first chain is selected.
   */
  describeFork<TChain extends Chain>(
    name: string,
    targets: ForkTargets<TChain>,
    body: (fork: Fork<TChain>) => void,
    options?: ForkSuiteOptions,
  ): void;
  /**
   * A test inside {@link ForkAdapter.describeFork} (directly or in a nested `describe`) that
   * receives the nearest enclosing fork. Pass the chain
   * type (`itFork<typeof base>(...)`) for a typed client; the `describeFork` body's handle is
   * always precisely typed.
   */
  itFork<TChain extends Chain = Chain>(
    name: string,
    fn: (fork: Fork<TChain>) => Promise<void> | void,
    timeoutMs?: number,
  ): void;
}

/** A failed expectation's actual and expected values, rendered, when the error carries both. */
function expectation(error: unknown): { actual?: string; expected?: string } {
  if (typeof error !== "object" || error === null) return {};
  if (!("actual" in error) || !("expected" in error)) return {};
  const { actual, expected } = error as { actual: unknown; expected: unknown };
  if (actual === undefined && expected === undefined) return {};
  const render = (value: unknown) => (typeof value === "string" ? value : formatValue(value));
  return { actual: render(actual), expected: render(expected) };
}

const OUTSIDE = "forkit: itFork must be called inside a describeFork body.";
let lastTestId = 0;

export function createForkAdapter(runner: RunnerApi): ForkAdapter {
  // itFork resolves its fork when the test runs, from a stack that each describeFork's
  // beforeEach pushes and afterEach pops. Hooks run outer to inner and back, so the top is the
  // nearest enclosing describeFork, whatever order the runner collects nested `describe`
  // bodies in: jest and node:test run them inside the parent's body, but vitest and bun:test run
  // them after it returns, when a collection-time stack would already be empty.
  const running: { handle: object; suite: string }[] = [];
  // Only for early errors: the describeFork bodies being collected, and (vitest) their suites.
  const collecting: object[] = [];
  const suites = new WeakSet<SuiteNode>();
  const insideDescribeFork = (): boolean | undefined => {
    if (collecting.length > 0) return true;
    if (runner.currentSuite === undefined) return undefined; // can't tell yet; checked at run time
    for (let suite = runner.currentSuite(); suite !== undefined; suite = suite.suite) {
      if (suites.has(suite)) return true;
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
        if (suite !== undefined) suites.add(suite);
        collecting.push(handle);
        try {
          body(handle);
        } finally {
          collecting.pop();
        }
      });
    },
    itFork<TChain extends Chain = Chain>(
      name: string,
      fn: (fork: Fork<TChain>) => Promise<void> | void,
      timeoutMs?: number,
    ) {
      if (insideDescribeFork() === false) throw new ForkitError(OUTSIDE);
      runner.it(
        name,
        async () => {
          const current = running.at(-1);
          if (current === undefined) throw new ForkitError(OUTSIDE);
          const testId = ++lastTestId;
          const started = Date.now();
          const base = { testId, suite: current.suite, name };
          emitForkitEvent({ type: "test:start", ts: started, ...base });
          try {
            await fn(current.handle as Fork<TChain>);
          } catch (error) {
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
        },
        timeoutMs,
      );
    },
  };
}
