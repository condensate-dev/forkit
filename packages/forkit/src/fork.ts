import { Instance } from "prool";
import type { Address, Chain, Hex } from "viem";
import { assertAnvilInstalled, freePort, isOpStack } from "./anvil.ts";
import { expectBalanceChange, type NATIVE } from "./assertions.ts";
import {
  createForkClient,
  type ForkClient,
  type PrankClient,
  type RawRequest,
  rawRequest,
} from "./client.ts";
import { type DealOptions, dealErc20 } from "./deal.ts";
import { ForkBootError, ForkitError } from "./errors.ts";
import { emitForkitEvent } from "./events.ts";
import { type GasSnapshotSettings, recordGas, resolveGasSettings } from "./gas.ts";
import { label } from "./labels.ts";
import { redactUrl, resolveForkUrl, rpcEnvVar } from "./rpc.ts";
import {
  type RpcCache,
  type RpcCacheStats,
  resolveCacheSettings,
  startRpcCache,
} from "./rpc-cache.ts";
import { formatTrace, traceTransaction } from "./trace.ts";
import type { Fork, ForkOptions, ForkTarget, GasSource, SnapshotId } from "./types.ts";

export const DEFAULT_BOOT_TIMEOUT_MS = 120_000;
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;

type AnvilInstance = ReturnType<typeof Instance.anvil>;

function isForkOptions<TChain extends Chain>(
  target: ForkTarget<TChain>,
): target is ForkOptions<TChain> {
  return "chain" in target && typeof target.chain === "object";
}

export function toForkOptions<TChain extends Chain>(
  target: ForkTarget<TChain>,
): ForkOptions<TChain> {
  return isForkOptions(target) ? target : { chain: target };
}

/**
 * The anvil flags forkit passes. Exported for tests. `viaCache` means `url` is forkit's local
 * recording proxy: then anvil's own disk cache is off (it would hide requests from the
 * recording) and so is its rate limiter (the proxy is local).
 */
export function anvilParameters(
  options: ForkOptions,
  url: string,
  port: number,
  viaCache = false,
): Instance.anvil.Parameters {
  return {
    binary: options.anvilBinary ?? "anvil",
    host: "127.0.0.1",
    port,
    forkUrl: url,
    ...(options.blockNumber === undefined ? {} : { forkBlockNumber: options.blockNumber }),
    // Only ever pass `true`: prool renders `false` as `--optimism false`, which anvil rejects.
    ...(isOpStack(options.chain) ? { optimism: true } : {}),
    ...(viaCache ? { noStorageCaching: true, noRateLimit: true } : {}),
  };
}

/** The per-handle settings that come from options and env; each throws on a bad value. */
export interface HandleSettings {
  traces: boolean;
  gas: GasSnapshotSettings;
  warn: (message: string) => void;
}

/**
 * Resolve a fork's options into handle settings. Called before anything boots or is leased, so a
 * bad option throws with nothing left running or held.
 */
export function resolveHandleSettings(options: ForkOptions): HandleSettings {
  return {
    traces: resolveTraces(options.traces),
    gas: resolveGasSettings(options.gasSnapshot, options.gasSnapshotFile),
    warn: options.onWarn ?? ((message: string) => console.warn(message)),
  };
}

/** `traces` option, then `FORKIT_TRACES`, then `on-failure`. */
export function resolveTraces(
  option: ForkOptions["traces"],
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = option ?? env.FORKIT_TRACES ?? "on-failure";
  if (value !== "on-failure" && value !== "off") {
    throw new ForkitError(
      `forkit: traces must be "on-failure" or "off", got ${JSON.stringify(value)}`,
    );
  }
  return value === "on-failure";
}

/** Gas used by a transaction: from its receipt, else (anvil 1.8 after evm_revert) its trace. */
async function gasUsedBy(request: RawRequest, tx: GasSource): Promise<bigint> {
  const resolved = await (typeof tx === "function" ? tx() : tx);
  const hash = typeof resolved === "string" ? resolved : resolved.transactionHash;
  if (typeof resolved === "object" && typeof resolved.gasUsed === "bigint") return resolved.gasUsed;
  const receipt = (await request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(
    () => null,
  )) as { gasUsed?: Hex } | null;
  if (receipt?.gasUsed !== undefined) return BigInt(receipt.gasUsed);
  const frame = await traceTransaction(request, hash);
  if (frame.gasUsed === undefined) throw new ForkitError(`forkit: no gas used for ${hash}`);
  return BigInt(frame.gasUsed);
}

function toCount(value: bigint | number, what: string): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ForkitError(`forkit: ${what} must be a non-negative integer, got ${String(value)}`);
  }
  return n;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function killHard(instance: AnvilInstance): void {
  try {
    instance._internal.process?.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * The forks booted by one `fork()` call. Every handle in a group can reach the others with
 * `on(chain)`, and stopping any of them stops them all.
 */
class ForkGroup {
  /** Indexed by position in the `fork()` call, not by boot order (chains boot in parallel). */
  readonly #slots: Fork[] = [];
  readonly #stoppers: (() => Promise<void>)[] = [];

  get members(): readonly Fork[] {
    return this.#slots.filter((m) => m !== undefined);
  }

  add(slot: number, member: Fork, stopSelf: () => Promise<void>): void {
    this.#slots[slot] = member;
    this.#stoppers.push(stopSelf);
  }

  /** Idempotent: each member memoizes its own stop. */
  async stop(): Promise<void> {
    await Promise.all(this.#stoppers.map((stopSelf) => stopSelf()));
  }
}

function describeChains(chains: readonly Chain[]): string {
  return chains.map((c) => `${c.name} (${c.id})`).join(", ");
}

class SingleFork<TChain extends Chain> implements Fork<TChain> {
  readonly chain: TChain;
  readonly rpcUrl: string;
  readonly client: ForkClient<TChain>;
  /** Same endpoint, typed against the wide `Chain` for chain-agnostic helpers. */
  readonly #anyChainClient: ForkClient;
  readonly #stopOwner: () => Promise<void>;
  readonly #cache: RpcCache | undefined;
  readonly #gas: GasSnapshotSettings;
  readonly #pranks = new Map<string, number>();
  readonly #group: ForkGroup;
  readonly #traces: boolean;
  readonly #warn: (message: string) => void;
  #stopping: Promise<void> | undefined;

  constructor(
    chain: TChain,
    rpcUrl: string,
    /** Stops the anvil behind this handle, or, for an attached handle, releases it. */
    stopOwner: () => Promise<void>,
    cache: RpcCache | undefined,
    group: ForkGroup,
    slot: number,
    traces: boolean,
    gas: GasSnapshotSettings,
    warn: (message: string) => void,
  ) {
    this.chain = chain;
    this.rpcUrl = rpcUrl;
    this.#traces = traces;
    this.#warn = warn;
    this.client = createForkClient(chain, rpcUrl, undefined, traces, warn);
    this.#anyChainClient = createForkClient<Chain>(chain, rpcUrl, undefined, traces, warn);
    this.#stopOwner = stopOwner;
    this.#cache = cache;
    this.#gas = gas;
    this.#group = group;
    group.add(slot, this as unknown as Fork, () => this.#stopSelf());
  }

  get forks(): readonly Fork[] {
    return this.#group.members;
  }

  cacheStats(): RpcCacheStats | undefined {
    return this.#cache?.stats();
  }

  async deal(
    token: Address,
    holder: Address,
    amount: bigint,
    options?: DealOptions,
  ): Promise<void> {
    await dealErc20(this.#anyChainClient, token, holder, amount, options);
  }

  async dealNative(holder: Address, amount: bigint): Promise<void> {
    await this.client.setBalance({ address: holder, value: amount });
  }

  async prank<T>(account: Address, fn: (client: PrankClient<TChain>) => Promise<T>): Promise<T> {
    const key = account.toLowerCase();
    const depth = this.#pranks.get(key) ?? 0;
    if (depth === 0) await this.client.impersonateAccount({ address: account });
    this.#pranks.set(key, depth + 1);
    let result: T;
    try {
      result = await fn(
        createForkClient(this.chain, this.rpcUrl, account, this.#traces, this.#warn),
      );
    } catch (error) {
      // fn's error is the one that matters; a failure to stop impersonating must not hide it.
      await this.#endPrank(key, account).catch(() => {});
      throw error;
    }
    await this.#endPrank(key, account);
    return result;
  }

  async #endPrank(key: string, account: Address): Promise<void> {
    const remaining = (this.#pranks.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.#pranks.set(key, remaining);
      return;
    }
    this.#pranks.delete(key);
    await this.client.stopImpersonatingAccount({ address: account });
  }

  async warp(seconds: bigint | number): Promise<void> {
    await this.client.increaseTime({ seconds: toCount(seconds, "warp seconds") });
    await this.client.mine({ blocks: 1 });
  }

  async roll(blocks: bigint | number): Promise<void> {
    const count = toCount(blocks, "roll blocks");
    if (count > 0) await this.client.mine({ blocks: count });
  }

  label(address: Address, name: string): void {
    label(address, name);
  }

  async trace(hash: Hex): Promise<string> {
    return formatTrace(await traceTransaction(rawRequest(this.client), hash));
  }

  expectBalanceChange<T>(
    token: Address | typeof NATIVE,
    holder: Address,
    delta: bigint,
    fn: () => Promise<T>,
  ): Promise<T> {
    return expectBalanceChange(this.client, token, holder, delta, fn);
  }

  async gasSnapshot(label: string, tx: GasSource): Promise<bigint> {
    const gas = await gasUsedBy(rawRequest(this.client), tx);
    await recordGas(this.#gas, label, gas);
    return gas;
  }

  async snapshot(): Promise<SnapshotId> {
    return await this.client.snapshot();
  }

  async revertTo(id: SnapshotId): Promise<void> {
    const ok = await rawRequest(this.client)({ method: "evm_revert", params: [id] });
    if (ok !== true) {
      throw new ForkitError(
        `forkit: anvil has no snapshot ${id}. A revert consumes the snapshot and every later one; take a new snapshot before reverting again.`,
      );
    }
  }

  on<TOther extends Chain>(chain: TOther): Fork<TOther> {
    const member = this.#group.members.find((m) => m.chain.id === chain.id);
    if (member === undefined) {
      throw new ForkitError(
        `forkit: this handle forks ${describeChains(this.#group.members.map((m) => m.chain))}, not ${chain.name} (${chain.id}).`,
      );
    }
    return member as unknown as Fork<TOther>;
  }

  /** Stop every fork in the handle (for a multi-chain fork, all of them). Idempotent. */
  stop(): Promise<void> {
    return this.#group.stop();
  }

  #stopSelf(): Promise<void> {
    this.#stopping ??= this.#stopOwner().then(() => this.#cache?.close());
    return this.#stopping;
  }
}

async function forkOne<TChain extends Chain>(
  target: ForkTarget<TChain>,
  group: ForkGroup,
  slot: number,
): Promise<Fork<TChain>> {
  const options = toForkOptions(target);
  const { chain } = options;
  const warn = options.onWarn ?? ((message: string) => console.warn(message));
  assertAnvilInstalled(options.anvilBinary);

  const rpc = resolveForkUrl(chain, options.forkUrl);
  if (options.blockNumber === undefined) {
    warn(
      `forkit: forking ${chain.name} (${chain.id}) at the live head. This run is not reproducible; pin blockNumber.`,
    );
  }

  // Resolve every option before anything boots: a bad value must throw with no anvil (or RPC
  // cache) left running behind it.
  const cacheSettings = resolveCacheSettings(options.cache, options.cacheDir);
  const settings = resolveHandleSettings(options);
  const cache =
    options.blockNumber === undefined || cacheSettings.mode === "off"
      ? undefined
      : await startRpcCache({
          upstream: rpc.url,
          chainId: chain.id,
          blockNumber: options.blockNumber,
          mode: cacheSettings.mode,
          dir: cacheSettings.dir,
          port: await freePort(),
          onWarn: warn,
        });

  const port = await freePort();
  const instance = Instance.anvil(
    anvilParameters(options, cache?.url ?? rpc.url, port, cache !== undefined),
  );
  const bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const where = `${chain.name} (${chain.id}) via ${redactUrl(rpc.url)}${
    options.blockNumber === undefined ? "" : ` at block ${options.blockNumber}`
  }`;
  const bootStarted = Date.now();
  try {
    await withTimeout(
      instance.start(),
      bootTimeoutMs,
      () =>
        new ForkBootError(
          `forkit: anvil did not become ready within ${bootTimeoutMs}ms forking ${where}. Public RPCs are slow and rate limited; set ${rpcEnvVar(chain.id)} to a paid endpoint or raise bootTimeoutMs.`,
        ),
    );
  } catch (error) {
    killHard(instance);
    await cache?.close();
    if (error instanceof ForkBootError) throw error;
    throw new ForkBootError(`forkit: anvil failed to fork ${where}`, { cause: error });
  }

  const rpcUrl = `http://127.0.0.1:${port}`;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const handle = new SingleFork(
    chain,
    rpcUrl,
    () =>
      withTimeout(
        instance.stop(),
        stopTimeoutMs,
        () => new ForkitError(`forkit: anvil did not stop within ${stopTimeoutMs}ms`),
      ).catch(() => {
        // Graceful stop wedged or failed: make sure the process is gone, never hang the suite.
        killHard(instance);
      }),
    cache,
    group,
    slot,
    settings.traces,
    settings.gas,
    settings.warn,
  );
  const servedChainId = await handle.client.getChainId().catch(async (error: unknown) => {
    await handle.stop();
    throw new ForkBootError(`forkit: anvil started but does not answer on ${rpcUrl}`, {
      cause: error,
    });
  });
  if (servedChainId !== chain.id) {
    await handle.stop();
    throw new ForkBootError(
      `forkit: ${redactUrl(rpc.url)} serves chain ${servedChainId}, but the fork asked for ${chain.name} (${chain.id}).`,
    );
  }
  const cacheStats = handle.cacheStats();
  emitForkitEvent({
    type: "fork:boot",
    ts: Date.now(),
    chainId: chain.id,
    chainName: chain.name,
    ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
    upstream: redactUrl(rpc.url),
    rpcUrl,
    ...(cacheStats === undefined ? {} : { cache: cacheStats }),
    bootMs: Date.now() - bootStarted,
  });
  return handle;
}

/** A running anvil to attach to (see `attachSharedFork`). */
export interface AttachTarget<TChain extends Chain = Chain> {
  options: ForkOptions<TChain>;
  rpcUrl: string;
}

/**
 * Handles on anvils forkit did not start. `stop()` on any of them calls `release` once and never
 * kills the process.
 */
export async function attachForks(
  targets: readonly AttachTarget[],
  release: () => Promise<void>,
): Promise<Fork> {
  const settings = targets.map(({ options }) => resolveHandleSettings(options));
  const group = new ForkGroup();
  let released: Promise<void> | undefined;
  const releaseOnce = () => {
    released ??= release();
    return released;
  };
  const handles = targets.map(
    ({ options, rpcUrl }, slot) =>
      new SingleFork(
        options.chain,
        rpcUrl,
        releaseOnce,
        undefined,
        group,
        slot,
        (settings[slot] as HandleSettings).traces,
        (settings[slot] as HandleSettings).gas,
        (settings[slot] as HandleSettings).warn,
      ),
  );
  for (const handle of handles) {
    const served = await handle.client.getChainId().catch(async (error: unknown) => {
      await releaseOnce();
      throw new ForkBootError(`forkit: no anvil answers on ${handle.rpcUrl}`, { cause: error });
    });
    if (served !== handle.chain.id) {
      await releaseOnce();
      throw new ForkBootError(
        `forkit: ${handle.rpcUrl} serves chain ${served}, but ${handle.chain.name} (${handle.chain.id}) was asked for.`,
      );
    }
  }
  const first = handles[0];
  if (first === undefined) throw new ForkitError("forkit: nothing to attach to.");
  return first as unknown as Fork;
}

/**
 * Boot an anvil fork of one chain, or of several chains for cross-chain tests.
 *
 * With several targets, every chain boots in parallel on its own anvil and port. The handle
 * selects the first chain; `on(chain)` selects another, and `stop()` on any of them stops all.
 * If one chain fails to boot, the others are stopped before the error is thrown.
 */
export function fork<TChain extends Chain>(target: ForkTarget<TChain>): Promise<Fork<TChain>>;
export function fork<TChain extends Chain>(
  targets: readonly [ForkTarget<TChain>, ...ForkTarget[]],
): Promise<Fork<TChain>>;
export async function fork(target: ForkTarget | readonly ForkTarget[]): Promise<Fork> {
  const group = new ForkGroup();
  if (!Array.isArray(target)) return await forkOne(target as ForkTarget, group, 0);

  const targets = target as readonly ForkTarget[];
  if (targets.length === 0) throw new ForkitError("forkit: fork([]) needs at least one chain.");
  const chains = targets.map((t) => toForkOptions(t).chain);
  const seen = new Set<number>();
  for (const chain of chains) {
    if (seen.has(chain.id)) {
      throw new ForkitError(
        `forkit: fork([...]) lists chain ${chain.id} twice (${describeChains(chains)}). Each chain gets one fork; select it with on(chain).`,
      );
    }
    seen.add(chain.id);
  }
  const booted = await Promise.allSettled(targets.map((t, slot) => forkOne(t, group, slot)));
  const failed = booted.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed !== undefined) {
    await group.stop();
    throw failed.reason;
  }
  return (booted[0] as PromiseFulfilledResult<Fork>).value;
}
