import type { Address, Chain } from "viem";
import { assertAnvilInstalled } from "./anvil.ts";
import type { ForkClient, PrankClient } from "./client.ts";
import type { DealOptions } from "./deal.ts";
import { ForkitError } from "./errors.ts";
import { DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS, fork, toForkOptions } from "./fork.ts";
import type { RpcCacheStats } from "./rpc-cache.ts";
import type { Fork, ForkOptions, ForkTarget, SnapshotId } from "./types.ts";

type Hook = () => Promise<void> | void;
type RegisterHook = (fn: Hook, timeoutMs?: number) => void;

/** The lifecycle hooks of whichever test runner an adapter wraps. */
export interface SuiteHooks {
  beforeAll: RegisterHook;
  afterAll: RegisterHook;
  beforeEach: RegisterHook;
  afterEach: RegisterHook;
}

export interface ForkSuiteOptions {
  /**
   * Snapshot every chain before each test and revert after it (default `true`). Tests in one
   * suite share a fork, so isolation assumes they run one at a time: do not use
   * `describe.concurrent` / `test.concurrent` inside a fork suite.
   */
  isolate?: boolean;
}

/** One chain, or several for a multi-chain fork (the first is selected). */
export type ForkTargets<TChain extends Chain = Chain> =
  | ForkTarget<TChain>
  | readonly [ForkTarget<TChain>, ...ForkTarget[]];

/** Slack on top of forkit's own ceilings, so forkit's error wins the race against the runner's. */
const HOOK_SLACK_MS = 5_000;
const EACH_HOOK_TIMEOUT_MS = 30_000;

const NOT_RUNNING =
  "forkit: the fork is not running. Use it inside a test or hook, not while tests are being collected.";

/**
 * A {@link Fork} that forwards to the fork booted in `beforeAll`. Using it before then (e.g. at
 * collection time) throws, except `on(chain)`, which returns another deferred handle.
 */
class DeferredFork<TChain extends Chain> implements Fork<TChain> {
  readonly chain: TChain;
  readonly #resolve: () => Fork<TChain> | undefined;

  constructor(chain: TChain, resolve: () => Fork<TChain> | undefined) {
    this.chain = chain;
    this.#resolve = resolve;
  }

  get #fork(): Fork<TChain> {
    const current = this.#resolve();
    if (current === undefined) throw new ForkitError(NOT_RUNNING);
    return current;
  }

  get forks(): readonly Fork[] {
    return this.#fork.forks;
  }
  get rpcUrl(): string {
    return this.#fork.rpcUrl;
  }
  cacheStats(): RpcCacheStats | undefined {
    return this.#fork.cacheStats();
  }
  get client(): ForkClient<TChain> {
    return this.#fork.client;
  }
  deal(token: Address, holder: Address, amount: bigint, options?: DealOptions): Promise<void> {
    return this.#fork.deal(token, holder, amount, options);
  }
  dealNative(holder: Address, amount: bigint): Promise<void> {
    return this.#fork.dealNative(holder, amount);
  }
  prank<T>(account: Address, fn: (client: PrankClient<TChain>) => Promise<T>): Promise<T> {
    return this.#fork.prank(account, fn);
  }
  warp(seconds: bigint | number): Promise<void> {
    return this.#fork.warp(seconds);
  }
  roll(blocks: bigint | number): Promise<void> {
    return this.#fork.roll(blocks);
  }
  snapshot(): Promise<SnapshotId> {
    return this.#fork.snapshot();
  }
  revertTo(id: SnapshotId): Promise<void> {
    return this.#fork.revertTo(id);
  }
  on<TOther extends Chain>(chain: TOther): Fork<TOther> {
    const current = this.#resolve();
    // Running: select now, so an unknown chain throws here. Collecting: defer, checked on use.
    if (current !== undefined) return current.on(chain);
    return new DeferredFork(chain, () => this.#resolve()?.on(chain));
  }
  stop(): Promise<void> {
    return this.#fork.stop();
  }
}

/**
 * Runner-agnostic fork lifecycle: boot once per suite, snapshot/revert every chain around every
 * test, stop at the end. Call it while tests are being collected: a missing anvil throws right
 * here, so the suite fails loudly instead of skipping.
 */
export function createForkSuite<TChain extends Chain>(
  targets: ForkTargets<TChain>,
  hooks: SuiteHooks,
  options: ForkSuiteOptions = {},
): Fork<TChain> {
  const list: readonly ForkOptions[] = (
    Array.isArray(targets) ? (targets as readonly ForkTarget[]) : [targets as ForkTarget]
  ).map((t) => toForkOptions(t));
  const first = list[0];
  if (first === undefined) throw new ForkitError("forkit: a fork suite needs at least one chain.");
  for (const binary of new Set(list.map((o) => o.anvilBinary))) assertAnvilInstalled(binary);

  let current: Fork<TChain> | undefined;
  const handle = new DeferredFork(first.chain as TChain, () => current);
  let snapshots: [Fork, SnapshotId][] = [];

  // Chains boot in parallel, so the slowest one sets the ceiling.
  const bootMs = Math.max(...list.map((o) => o.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS));
  const stopMs = Math.max(...list.map((o) => o.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS));
  hooks.beforeAll(async () => {
    const booted =
      list.length === 1
        ? await fork(first)
        : await fork(list as unknown as readonly [ForkTarget, ...ForkTarget[]]);
    current = booted as unknown as Fork<TChain>;
  }, bootMs + HOOK_SLACK_MS);
  hooks.afterAll(async () => {
    await current?.stop();
    current = undefined;
  }, stopMs + HOOK_SLACK_MS);
  if (options.isolate !== false) {
    hooks.beforeEach(async () => {
      if (current === undefined) return;
      snapshots = await Promise.all(
        current.forks.map(async (f): Promise<[Fork, SnapshotId]> => [f, await f.snapshot()]),
      );
    }, EACH_HOOK_TIMEOUT_MS);
    hooks.afterEach(async () => {
      const taken = snapshots;
      snapshots = [];
      await Promise.all(taken.map(([f, id]) => f.revertTo(id)));
    }, EACH_HOOK_TIMEOUT_MS);
  }
  return handle;
}
