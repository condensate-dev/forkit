/**
 * The settle loop, with no chain: rounds never overlap, an error does not stop the loop, and
 * stop() waits for the settle in progress.
 */
import { describe, expect, test } from "vitest";
import { runBridges } from "../../src/bridges/index.ts";
import { ForkitError } from "../../src/index.ts";

/** A promise that resolves when `ready()` holds, checked every millisecond. */
async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((resolve) => setTimeout(resolve, 1));
}

describe("bridge.run", () => {
  test("settles every simulator in turn, round after round, with no overlap", async () => {
    let running = 0;
    let overlapped = false;
    const order: string[] = [];
    const simulator = (name: string) => ({
      async settle() {
        if (++running > 1) overlapped = true;
        order.push(name);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
      },
    });
    const stop = runBridges([simulator("a"), simulator("b")], {
      intervalMs: 0,
      onError: (error) => {
        throw error;
      },
    });
    await until(() => order.length >= 6);
    await stop();
    expect(overlapped).toBe(false);
    expect(order.slice(0, 6)).toEqual(["a", "b", "a", "b", "a", "b"]);
  });

  test("an error goes to onError and the loop goes on", async () => {
    const errors: unknown[] = [];
    let rounds = 0;
    const stop = runBridges(
      [
        {
          async settle() {
            rounds++;
            if (rounds === 1) throw new Error("fill failed");
          },
        },
      ],
      { intervalMs: 0, onError: (error) => errors.push(error) },
    );
    await until(() => rounds >= 3);
    await stop();
    expect(errors).toEqual([new Error("fill failed")]);
  });

  test("stop() waits for the settle in progress, and no settle starts after it", async () => {
    let started = 0;
    let finished = 0;
    let release: () => void = () => {};
    const stop = runBridges(
      [
        {
          async settle() {
            started++;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            finished++;
          },
        },
      ],
      { intervalMs: 0, onError: () => {} },
    );
    await until(() => started === 1);
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect([started, finished]).toEqual([1, 1]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(1);
  });

  test("stop() does not wait out the pause between rounds", async () => {
    let rounds = 0;
    const stop = runBridges(
      [
        {
          async settle() {
            rounds++;
          },
        },
      ],
      { intervalMs: 60_000, onError: () => {} },
    );
    await until(() => rounds === 1);
    const before = Date.now();
    await stop();
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(rounds).toBe(1);
  });

  test("an onError that throws ends the loop, and stop() rejects with what it threw", async () => {
    const stop = runBridges(
      [
        {
          async settle() {
            throw new Error("fill failed");
          },
        },
      ],
      {
        intervalMs: 0,
        onError: () => {
          throw new Error("the handler broke");
        },
      },
    );
    await expect(stop()).rejects.toThrow("the handler broke");
  });

  test("refuses no simulators and a bad interval", () => {
    const one = [{ settle: async () => {} }];
    expect(() => runBridges([], { onError: () => {} })).toThrow(ForkitError);
    expect(() => runBridges(one, { intervalMs: -1, onError: () => {} })).toThrow(
      /intervalMs is -1/,
    );
    expect(() => runBridges(one, { intervalMs: Number.NaN, onError: () => {} })).toThrow(
      /intervalMs is NaN/,
    );
  });
});
