import type { Address, Chain } from "viem";
import { assertAnvilInstalled } from "./anvil.ts";
import type { ForkClient, PrankClient } from "./client.ts";
import type { DealOptions } from "./deal.ts";
import { ForkitError } from "./errors.ts";
import { DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS, fork, toForkOptions } from "./fork.ts";
import type { RpcCacheStats } from "./rpc-cache.ts";
import type { Fork, ForkTarget, SnapshotId } from "./types.ts";

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
   * Snapshot before each test and revert after it (default `true`). Tests in one suite share a
   * fork, so isolation assumes they run one at a time: do not use `describe.concurrent` /
   * `test.concurrent` inside a fork suite.
   */
  isolate?: boolean;
}

/** Slack on top of forkit's own ceilings, so forkit's error wins the race against the runner's. */
const HOOK_SLACK_MS = 5_000;
const EACH_HOOK_TIMEOUT_MS = 30_000;

/**
 * A {@link Fork} that forwards to the fork booted in `beforeAll`. Using it before then (e.g. at
 * collection time) throws.
 */
class DeferredFork<TChain extends Chain> implements Fork<TChain> {
  readonly chain: TChain;
  current: Fork<TChain> | undefined;

  constructor(chain: TChain) {
    this.chain = chain;
  }

  get #fork(): Fork<TChain> {
    if (this.current === undefined) {
      throw new ForkitError(
        "forkit: the fork is not running. Use it inside a test or hook, not while tests are being collected.",
      );
    }
    return this.current;
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
    return this.#fork.on(chain);
  }
  stop(): Promise<void> {
    return this.#fork.stop();
  }
}

/**
 * Runner-agnostic fork lifecycle: boot once per suite, snapshot/revert around every test, stop
 * at the end. Call it while tests are being collected: a missing anvil throws right here, so the
 * suite fails loudly instead of skipping.
 */
export function createForkSuite<TChain extends Chain>(
  target: ForkTarget<TChain>,
  hooks: SuiteHooks,
  options: ForkSuiteOptions = {},
): Fork<TChain> {
  const forkOptions = toForkOptions(target);
  assertAnvilInstalled(forkOptions.anvilBinary);
  const handle = new DeferredFork(forkOptions.chain);
  let snapshot: SnapshotId | undefined;

  hooks.beforeAll(
    async () => {
      handle.current = await fork(forkOptions);
    },
    (forkOptions.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS) + HOOK_SLACK_MS,
  );
  hooks.afterAll(
    async () => {
      await handle.current?.stop();
      handle.current = undefined;
    },
    (forkOptions.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS) + HOOK_SLACK_MS,
  );
  if (options.isolate !== false) {
    hooks.beforeEach(async () => {
      if (handle.current !== undefined) snapshot = await handle.current.snapshot();
    }, EACH_HOOK_TIMEOUT_MS);
    hooks.afterEach(async () => {
      if (handle.current !== undefined && snapshot !== undefined) {
        const id = snapshot;
        snapshot = undefined;
        await handle.current.revertTo(id);
      }
    }, EACH_HOOK_TIMEOUT_MS);
  }
  return handle;
}
