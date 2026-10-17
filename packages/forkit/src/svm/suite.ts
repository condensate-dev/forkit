/**
 * Runner-agnostic surfnet lifecycle for one suite: check surfpool while collecting, boot in
 * `beforeAll`, stop in `afterAll`. The runner adapters (`@condensate/forkit/svm/vitest`,
 * `/svm/bun`) are this plus their imports.
 */
import type { Rpc, RpcSubscriptions, SolanaRpcApi, SolanaRpcSubscriptionsApi } from "@solana/kit";
import { ForkitError } from "../errors.ts";
import type { SuiteHooks } from "../suite.ts";
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
}

/**
 * Register one surfnet's lifecycle on a runner's hooks and return its handle. Call it while tests
 * are being collected: a missing or too-old surfpool throws right here, so the suite fails
 * loudly instead of skipping.
 */
export function createSurfnetSuite(options: SurfnetOptions, hooks: SuiteHooks): Surfnet {
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
  return new DeferredSurfnet(() => current);
}
