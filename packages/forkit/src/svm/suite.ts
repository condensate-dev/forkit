/**
 * Runner-agnostic surfnet lifecycle for one suite: check surfpool while collecting, boot in
 * `beforeAll`, stop in `afterAll`. The runner adapters (`@condensate/forkit/svm/vitest`,
 * `/svm/bun`) are this plus their imports.
 */
import type {
  Address,
  Rpc,
  RpcSubscriptions,
  SolanaRpcApi,
  SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import { ForkitError } from "../errors.ts";
import type { SuiteHooks } from "../suite.ts";
import type {
  AccountPatch,
  DealTokenOptions,
  EtchOptions,
  ResetOptions,
  SurfnetClock,
  SurfnetEpochInfo,
  WarpTarget,
} from "./cheats.ts";
import {
  DEFAULT_SURFNET_BOOT_TIMEOUT_MS,
  DEFAULT_SURFNET_STOP_TIMEOUT_MS,
  type Surfnet,
  type SurfnetInfo,
  type SurfnetOptions,
  surfnet,
} from "./surfnet.ts";
import { assertSurfpoolInstalled, resolveSurfpoolBinary } from "./surfpool.ts";

export type { SuiteHooks } from "../suite.ts";

export interface SurfnetSuiteOptions extends SurfnetOptions {
  /**
   * `reset()` the whole surfnet after every test (`surfnet_resetNetwork`), so each test starts
   * from the fork source's current state. Default false. Not a snapshot revert: accounts load
   * again from the source as it is now, and the clock goes back to the source's.
   */
  resetEach?: boolean;
}

const EACH_HOOK_TIMEOUT_MS = 30_000;

/** Slack on top of forkit's own ceilings, so forkit's error wins the race against the runner's. */
const HOOK_SLACK_MS = 5_000;

const NOT_RUNNING =
  "forkit: the surfnet is not running. Use it inside a test or hook, not while tests are being collected.";

/** A {@link Surfnet} that forwards to the one booted in `beforeAll`; throws before then. */
class DeferredSurfnet implements Surfnet {
  readonly #resolve: () => Surfnet | undefined;

  constructor(resolve: () => Surfnet | undefined) {
    this.#resolve = resolve;
  }

  get #surfnet(): Surfnet {
    const current = this.#resolve();
    if (current === undefined) throw new ForkitError(NOT_RUNNING);
    return current;
  }

  get rpcUrl(): string {
    return this.#surfnet.rpcUrl;
  }
  get wsUrl(): string {
    return this.#surfnet.wsUrl;
  }
  get source(): string {
    return this.#surfnet.source;
  }
  get surfpoolVersion(): string {
    return this.#surfnet.surfpoolVersion;
  }
  get rpc(): Rpc<SolanaRpcApi> {
    return this.#surfnet.rpc;
  }
  get rpcSubscriptions(): RpcSubscriptions<SolanaRpcSubscriptionsApi> {
    return this.#surfnet.rpcSubscriptions;
  }
  request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T> {
    return this.#surfnet.request<T>(method, params);
  }
  info(): Promise<SurfnetInfo> {
    return this.#surfnet.info();
  }
  stop(): Promise<void> {
    return this.#surfnet.stop();
  }
  setAccount(account: Address, patch: AccountPatch): Promise<void> {
    return this.#surfnet.setAccount(account, patch);
  }
  dealSol(account: Address, lamports: bigint): Promise<void> {
    return this.#surfnet.dealSol(account, lamports);
  }
  deal(
    mint: Address,
    owner: Address,
    amount: bigint,
    options?: DealTokenOptions,
  ): Promise<Address> {
    return this.#surfnet.deal(mint, owner, amount, options);
  }
  clock(): Promise<SurfnetClock> {
    return this.#surfnet.clock();
  }
  warp(seconds: bigint | number): Promise<SurfnetClock> {
    return this.#surfnet.warp(seconds);
  }
  roll(slots: bigint | number): Promise<SurfnetClock> {
    return this.#surfnet.roll(slots);
  }
  warpTo(target: WarpTarget): Promise<SurfnetEpochInfo> {
    return this.#surfnet.warpTo(target);
  }
  pauseClock(): Promise<SurfnetEpochInfo> {
    return this.#surfnet.pauseClock();
  }
  resumeClock(): Promise<SurfnetEpochInfo> {
    return this.#surfnet.resumeClock();
  }
  etch(programId: Address, program: Uint8Array | string, options?: EtchOptions): Promise<void> {
    return this.#surfnet.etch(programId, program, options);
  }
  setProgramAuthority(programId: Address, authority: Address | null): Promise<void> {
    return this.#surfnet.setProgramAuthority(programId, authority);
  }
  reset(account?: Address, options?: ResetOptions): Promise<void> {
    return this.#surfnet.reset(account, options);
  }
}

/**
 * Register one surfnet's lifecycle on a runner's hooks and return its handle. Call it while tests
 * are being collected: a missing or too-old surfpool throws right here, so the suite fails
 * loudly instead of skipping.
 */
export function createSurfnetSuite(options: SurfnetSuiteOptions, hooks: SuiteHooks): Surfnet {
  assertSurfpoolInstalled(resolveSurfpoolBinary(options.surfpoolBinary));
  let current: Surfnet | undefined;
  hooks.beforeAll(
    async () => {
      current = await surfnet(options);
    },
    (options.bootTimeoutMs ?? DEFAULT_SURFNET_BOOT_TIMEOUT_MS) + HOOK_SLACK_MS,
  );
  hooks.afterAll(
    async () => {
      try {
        await current?.stop();
      } finally {
        current = undefined;
      }
    },
    (options.stopTimeoutMs ?? DEFAULT_SURFNET_STOP_TIMEOUT_MS) + HOOK_SLACK_MS,
  );
  if (options.resetEach === true) {
    hooks.afterEach(async () => {
      await current?.reset();
    }, EACH_HOOK_TIMEOUT_MS);
  }
  return new DeferredSurfnet(() => current);
}
