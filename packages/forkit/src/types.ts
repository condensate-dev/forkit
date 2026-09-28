import type { Address, Chain, Hex } from "viem";
import type { ForkClient, PrankClient } from "./client.ts";
import type { DealOptions } from "./deal.ts";
import type { CacheMode, RpcCacheStats } from "./rpc-cache.ts";

/** Options for forking one chain. */
export interface ForkOptions<TChain extends Chain = Chain> {
  /** The viem chain to fork. OP-stack chains are detected from it and get `--optimism`. */
  chain: TChain;
  /** Block to pin the fork to. Unpinned forks warn, because they are not reproducible. */
  blockNumber?: bigint;
  /** Explicit RPC URL. Otherwise `FORKIT_RPC_URL_<chainId>`, then the chain's default RPC. */
  forkUrl?: string;
  /**
   * Fork state cache for pinned forks. forkit records every upstream answer at the pinned block
   * to `<cacheDir>/<chainId>/<block>.json` and replays it on later runs, so warm runs make no
   * network calls. Default `FORKIT_CACHE` or `readwrite`; use `offline` in CI with a committed
   * or restored cache, `off` to talk to the upstream directly. Unpinned forks are never cached.
   */
  cache?: CacheMode;
  /** Cache directory. Default `FORKIT_CACHE_DIR` or `.forkit-cache` in the working directory. */
  cacheDir?: string;
  /** Ceiling for anvil boot and fork sync, in milliseconds. Default 120 000. */
  bootTimeoutMs?: number;
  /** Ceiling for teardown, in milliseconds, so a wedged anvil cannot hang the suite. Default 10 000. */
  stopTimeoutMs?: number;
  /** anvil binary. Default `anvil` (from PATH). */
  anvilBinary?: string;
  /** Where warnings go (e.g. unpinned forks). Default `console.warn`. */
  onWarn?: (message: string) => void;
}

/** A chain, or the full options for one fork. */
export type ForkTarget<TChain extends Chain = Chain> = TChain | ForkOptions<TChain>;

/** Opaque id returned by {@link Fork.snapshot}. */
export type SnapshotId = Hex;

/** Handle to one or more running forks. */
export interface Fork<TChain extends Chain = Chain> {
  /** The forked chain. */
  readonly chain: TChain;
  /** URL of the local anvil JSON-RPC endpoint. */
  readonly rpcUrl: string;
  /** Hit/miss counts of the fork state cache, or `undefined` when it is not in use. */
  cacheStats(): RpcCacheStats | undefined;
  /** Typed viem client for the selected chain. */
  readonly client: ForkClient<TChain>;
  /**
   * Set `holder`'s ERC-20 balance to exactly `amount`: `anvil_dealERC20`, falling back to
   * storage-slot discovery, then verified by reading `balanceOf` back.
   */
  deal(token: Address, holder: Address, amount: bigint, options?: DealOptions): Promise<void>;
  /** Set a native balance. */
  dealNative(holder: Address, amount: bigint): Promise<void>;
  /** Impersonate `account` for the duration of `fn`; impersonation stops afterwards. */
  prank<T>(account: Address, fn: (client: PrankClient<TChain>) => Promise<T>): Promise<T>;
  /**
   * Advance block time by `seconds` (relative, unlike Foundry's absolute `vm.warp(timestamp)`)
   * and mine one block, so the new timestamp is visible. `warp(0)` still mines that block.
   */
  warp(seconds: bigint | number): Promise<void>;
  /**
   * Mine `blocks` blocks (relative, unlike Foundry's absolute `vm.roll(blockNumber)`).
   * `roll(0)` does nothing.
   */
  roll(blocks: bigint | number): Promise<void>;
  /** Take an EVM snapshot. */
  snapshot(): Promise<SnapshotId>;
  /**
   * Revert to a snapshot taken with {@link Fork.snapshot}. anvil consumes the snapshot (and any
   * later ones), so take a fresh one to revert again.
   */
  revertTo(id: SnapshotId): Promise<void>;
  /** Select one chain in a multi-fork handle. */
  on<TOther extends Chain>(chain: TOther): Fork<TOther>;
  /** Stop every anvil process behind this handle. Idempotent. */
  stop(): Promise<void>;
}
