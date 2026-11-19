/**
 * The settle loop of a long-running stack: settle bridge simulators again and again until
 * stopped. See docs/guides/long-running-stacks.md.
 */
import { ForkitError } from "../errors.ts";

/** Anything with a `settle()`: every bridge simulator. */
export interface Settleable {
  settle(): Promise<unknown>;
}

export interface RunBridgesOptions {
  /** The pause between the end of one round and the start of the next, in milliseconds. Default 1000. */
  intervalMs?: number;
  /**
   * Called with the error of each settle that rejects. The loop goes on. It has no default, so
   * that no error is dropped without a decision. If it throws, the loop ends and `stop()` rejects
   * with what it threw.
   */
  onError: (error: unknown) => void;
}

/**
 * Settle `simulators` in rounds until the returned function is called. A round settles each
 * simulator in turn, and the next round starts `intervalMs` after the last one ended, so two
 * settles never overlap. The returned function stops the loop and resolves once the settle in
 * progress is done.
 *
 * ```ts
 * const stop = bridge.run([across, relay], { intervalMs: 500, onError: console.error });
 * // on shutdown:
 * await stop();
 * ```
 */
export function runBridges(
  simulators: readonly Settleable[],
  options: RunBridgesOptions,
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new ForkitError(
      `forkit: bridge.run intervalMs is ${intervalMs}; pass a number of milliseconds, 0 or more.`,
    );
  }
  if (simulators.length === 0) {
    throw new ForkitError("forkit: bridge.run has no simulator to settle; pass at least one.");
  }
  let stopped = false;
  let wake: (() => void) | undefined;
  const loop = (async () => {
    while (!stopped) {
      for (const simulator of simulators) {
        if (stopped) break;
        try {
          await simulator.settle();
        } catch (error) {
          options.onError(error);
        }
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        // stop() must not wait out the pause.
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  })();
  // stop() is the place a throwing onError surfaces; without this, it is an unhandled rejection
  // long before anyone calls stop().
  loop.catch(() => {});
  return () => {
    stopped = true;
    wake?.();
    return loop;
  };
}
