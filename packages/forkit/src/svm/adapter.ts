/**
 * Builds `describeSurfnet` / `itSurfnet` for one test runner, the Solana twin of
 * `describeFork` / `itFork`.
 */
import type { RunnerApi } from "../adapter.ts";
import { ForkitError } from "../errors.ts";
import { createSurfnetSuite } from "./suite.ts";
import type { Surfnet, SurfnetOptions } from "./surfnet.ts";

export interface SurfnetAdapter {
  /**
   * A `describe` block with its own surfnet: booted before the first test, stopped after the
   * last. `body` receives the handle; it is usable inside tests and hooks.
   */
  describeSurfnet(name: string, options: SurfnetOptions, body: (surfnet: Surfnet) => void): void;
  /** A test inside {@link SurfnetAdapter.describeSurfnet} that receives the nearest surfnet. */
  itSurfnet(name: string, fn: (surfnet: Surfnet) => Promise<void> | void, timeoutMs?: number): void;
}

const OUTSIDE = "forkit: itSurfnet must be called inside a describeSurfnet body.";

export function createSurfnetAdapter(runner: RunnerApi): SurfnetAdapter {
  // As in createForkAdapter: each describeSurfnet's beforeEach pushes its handle and afterEach
  // pops it, so the top is the nearest enclosing surfnet whatever order nested bodies run in.
  // An itSurfnet outside any describeSurfnet fails when it runs.
  const running: Surfnet[] = [];
  return {
    describeSurfnet(name, options, body) {
      runner.describe(name, () => {
        const handle = createSurfnetSuite(options, runner.hooks);
        runner.hooks.beforeEach(() => {
          running.push(handle);
        });
        runner.hooks.afterEach(() => {
          running.pop();
        });
        body(handle);
      });
    },
    itSurfnet(name, fn, timeoutMs) {
      runner.it(
        name,
        async () => {
          const current = running.at(-1);
          if (current === undefined) throw new ForkitError(OUTSIDE);
          await fn(current);
        },
        timeoutMs,
      );
    },
  };
}
