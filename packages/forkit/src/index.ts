/**
 * @condensate/forkit: Foundry-style fork tests in TypeScript.
 *
 * Milestone 1 ships the public API surface as typed stubs. Every function
 * throws {@link NotImplementedError} until the milestone that implements it
 * lands (see docs/spec.md, "Milestones").
 */
import type {
  AbiEvent,
  Address,
  Chain,
  GetEventArgs,
  Hex,
  PublicActions,
  TestClient,
  TransactionReceipt,
  Transport,
  WalletActions,
} from "viem";

/** Thrown by every API that a later milestone implements. */
export class NotImplementedError extends Error {
  override readonly name = "NotImplementedError";
  readonly api: string;
  readonly milestone: number;

  constructor(api: string, milestone: number) {
    super(`forkit: ${api} is not implemented yet (planned for milestone ${milestone})`);
    this.api = api;
    this.milestone = milestone;
  }
}

/** Options for forking one chain. */
export interface ForkOptions<TChain extends Chain = Chain> {
  /** The viem chain to fork. OP-stack chains are detected from it. */
  chain: TChain;
  /** Block to pin the fork to. Unpinned forks warn, because they are not reproducible. */
  blockNumber?: bigint;
  /** Explicit RPC URL. Otherwise: env override per chain id, then the chain's default RPC. */
  forkUrl?: string;
  /** anvil RPC cache directory, for faster and cheaper repeat runs. */
  cacheDir?: string;
  /** Ceiling for anvil boot and fork sync, in milliseconds. */
  bootTimeoutMs?: number;
  /** Ceiling for teardown, in milliseconds, so a wedged anvil cannot hang the suite. */
  stopTimeoutMs?: number;
}

/** A chain, or the full options for one fork. */
export type ForkTarget<TChain extends Chain = Chain> = TChain | ForkOptions<TChain>;

/** viem client with test, public and wallet actions, bound to one fork. */
export type ForkClient<TChain extends Chain = Chain> = TestClient<
  "anvil",
  Transport,
  TChain,
  undefined,
  true
> &
  PublicActions<Transport, TChain> &
  WalletActions<TChain>;

/** Opaque id returned by {@link Fork.snapshot}. */
export type SnapshotId = Hex;

/** Handle to one or more running forks. */
export interface Fork<TChain extends Chain = Chain> {
  /** Typed viem client for the selected chain. */
  readonly client: ForkClient<TChain>;
  /** Set an ERC-20 balance via `anvil_dealERC20`, verified by reading `balanceOf` back. */
  deal(token: Address, holder: Address, amount: bigint): Promise<void>;
  /** Set a native balance. */
  dealNative(holder: Address, amount: bigint): Promise<void>;
  /** Impersonate `account` for the duration of `fn`; impersonation stops afterwards. */
  prank<T>(account: Address, fn: (client: ForkClient<TChain>) => Promise<T>): Promise<T>;
  /** Advance block time by `seconds`. */
  warp(seconds: bigint | number): Promise<void>;
  /** Mine `blocks` blocks. */
  roll(blocks: bigint | number): Promise<void>;
  /** Take an EVM snapshot. */
  snapshot(): Promise<SnapshotId>;
  /** Revert to a snapshot taken with {@link Fork.snapshot}. */
  revertTo(id: SnapshotId): Promise<void>;
  /** Select one chain in a multi-fork handle. */
  on<TOther extends Chain>(chain: TOther): Fork<TOther>;
  /** Stop every anvil process behind this handle. */
  stop(): Promise<void>;
}

/** Boot an anvil fork of one chain, or of several chains for cross-chain tests. */
export function fork<TChain extends Chain>(target: ForkTarget<TChain>): Promise<Fork<TChain>>;
export function fork<TChain extends Chain>(
  targets: readonly [ForkTarget<TChain>, ...ForkTarget[]],
): Promise<Fork<TChain>>;
export async function fork(_target: ForkTarget | readonly ForkTarget[]): Promise<Fork> {
  throw new NotImplementedError("fork", 2);
}

/** Assert that `promise` reverts with a reason string or a 4-byte error selector. */
export async function expectRevert(
  _promise: Promise<unknown>,
  _reasonOrSelector: string | Hex,
): Promise<void> {
  throw new NotImplementedError("expectRevert", 4);
}

/**
 * Assert that `receipt` contains `event`, optionally matching `args`: a partial match on any of
 * the event's params, indexed or not. Values are exact (no event-filter OR arrays or wildcards).
 */
export function expectEmit<const TEvent extends AbiEvent>(
  _receipt: TransactionReceipt,
  _event: TEvent,
  _args?: GetEventArgs<
    readonly [TEvent],
    TEvent["name"],
    { EnableUnion: false; IndexedOnly: false; Required: false }
  >,
): void {
  throw new NotImplementedError("expectEmit", 4);
}

/**
 * Assert that running `fn` changes `holder`'s balance of `token` by exactly `delta`.
 * Resolves to whatever `fn` resolved to.
 */
export async function expectBalanceChange<T>(
  _token: Address,
  _holder: Address,
  _delta: bigint,
  _fn: () => Promise<T>,
): Promise<T> {
  throw new NotImplementedError("expectBalanceChange", 4);
}
