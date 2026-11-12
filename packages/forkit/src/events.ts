/**
 * Run events: what forkit did during a run, for reporters (`@condensate_dev/forkit/reporter`) and run
 * records (`forkit explore`). Emitting is synchronous and cheap; a listener that throws is
 * ignored, so observers can never break a test.
 */
import type { Address, Hex } from "viem";
import type { RpcCacheStats } from "./rpc-cache.ts";

interface Base {
  /** Milliseconds since the epoch. */
  ts: number;
}

/** A fork finished booting and answers on `rpcUrl`. */
export interface ForkBootEvent extends Base {
  type: "fork:boot";
  chainId: number;
  chainName: string;
  /** Pinned block, or undefined for a live-head fork. */
  blockNumber?: bigint;
  /** Upstream RPC with secrets masked. */
  upstream: string;
  /** Local anvil URL. */
  rpcUrl: string;
  /** Fork cache state right after boot, when the cache is in use. */
  cache?: RpcCacheStats;
  bootMs: number;
  /** The chain's native currency symbol (`ETH`, `POL`, ...). */
  nativeSymbol?: string;
}

/** A fork client sent a transaction (the hash is known; the receipt may not be yet). */
export interface TxSentEvent extends Base {
  type: "tx:sent";
  chainId: number;
  rpcUrl: string;
  hash: Hex;
  kind: "sendTransaction" | "writeContract" | "deployContract";
  from?: Address;
  to?: Address;
  data?: Hex;
  value?: bigint;
  /** For writeContract: the function called. */
  functionName?: string;
}

/** One log of a mined transaction, as in its receipt. */
export interface TxLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  logIndex: number;
}

/**
 * A transaction from a fork client was mined: its receipt, read right after the send (before any
 * per-test `evm_revert` can make the transaction unfindable). Emitted only while someone listens.
 */
export interface TxMinedEvent extends Base {
  type: "tx:mined";
  chainId: number;
  rpcUrl: string;
  hash: Hex;
  status: "success" | "reverted";
  from: Address;
  to?: Address;
  /** For a deployment: the new contract. */
  contractAddress?: Address;
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: TxLog[];
}

/** A fork client write reverted before it was mined (at estimation or send). */
export interface TxRevertedEvent extends Base {
  type: "tx:reverted";
  chainId: number;
  rpcUrl: string;
  kind: TxSentEvent["kind"];
  from?: Address;
  to?: Address;
  data?: Hex;
  value?: bigint;
  functionName?: string;
  message: string;
  /** Decoded call trace, when traces are on. */
  trace?: string;
}

/** A bridge simulator filled a deposit. */
export interface BridgeFillEvent extends Base {
  type: "bridge:fill";
  /** `across`, `relay`, or the name given to `bridge.custom`. */
  bridge: string;
  depositId: string;
  originChainId: number;
  destinationChainId: number;
  depositTxHash: Hex;
  txHashes: Hex[];
  outputAmount?: bigint;
  details?: Record<string, unknown>;
}

/** A gas snapshot measurement, with the committed value when there is one. */
export interface GasSnapshotEvent extends Base {
  type: "gas:snapshot";
  label: string;
  gas: bigint;
  mode: "write" | "check" | "off";
  file: string;
  previous?: bigint;
}

/** An HTTP request intercepted by `@condensate_dev/forkit/http`. */
export interface HttpEvent extends Base {
  type: "http:request";
  fixture: string;
  method: string;
  /** Redacted URL. */
  url: string;
  outcome: "hit" | "recorded" | "passthrough" | "unmatched";
}

/** An `itFork` test started. Events until its `test:end` belong to it. */
export interface TestStartEvent extends Base {
  type: "test:start";
  /** Unique within the process. */
  testId: number;
  /** The enclosing describeFork's name. */
  suite: string;
  name: string;
}

/** An `itFork` test finished. */
export interface TestEndEvent extends Base {
  type: "test:end";
  testId: number;
  suite: string;
  name: string;
  status: "pass" | "fail";
  durationMs: number;
  /** The failure's message, when it failed. */
  error?: string;
  /** A failed expectation's actual and expected values (e.g. from `ForkitAssertionError`), rendered. */
  actual?: string;
  expected?: string;
}

/** `deal` or `dealNative` set a balance. */
export interface DealEvent extends Base {
  type: "deal";
  chainId: number;
  rpcUrl: string;
  /** The ERC-20 token, or `native` for `dealNative`. */
  token: Address | "native";
  holder: Address;
  /** The balance it was set to. */
  amount: bigint;
}

/**
 * A cheatcode other than `deal`: a prank began or ended, time or blocks moved, or a snapshot was
 * taken or reverted to. The per-test isolation snapshot is not one: only the test's own calls are.
 */
export interface CheatEvent extends Base {
  type: "cheat";
  chainId: number;
  rpcUrl: string;
  cheat: "prank" | "stopPrank" | "warp" | "roll" | "snapshot" | "revert";
  /** `prank`, `stopPrank`: the impersonated account. */
  account?: Address;
  /** `warp`: seconds added. */
  seconds?: bigint;
  /** `roll`: blocks mined. */
  blocks?: bigint;
  /** `snapshot`, `revert`: the snapshot id. */
  snapshotId?: string;
  /** `warp`, `roll`: the latest block's number and timestamp afterwards, when read. */
  blockNumber?: bigint;
  timestamp?: bigint;
}

export type ForkitEvent =
  | TestStartEvent
  | TestEndEvent
  | ForkBootEvent
  | TxSentEvent
  | TxMinedEvent
  | TxRevertedEvent
  | BridgeFillEvent
  | GasSnapshotEvent
  | HttpEvent
  | DealEvent
  | CheatEvent;

type Listener = (event: ForkitEvent) => void;
const listeners = new Set<Listener>();

/** Observe every run event in this process. Returns an unsubscribe function. */
export function onForkitEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether anyone observes run events, so emitters can skip work nobody would see. */
export function hasForkitListeners(): boolean {
  return listeners.size > 0;
}

/** Emit a run event. Internal: forkit's own modules call this. */
export function emitForkitEvent(event: ForkitEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Observers must never break a test.
    }
  }
}

const work = new Set<Promise<unknown>>();

/**
 * Let an observer's async work (a run record reading receipts and traces, say) finish before
 * forkit changes the fork under it: `revertTo` and `stop` wait for it. A rejection is ignored.
 */
export function trackObserverWork(promise: Promise<unknown>): void {
  const tracked = promise.catch(() => {});
  work.add(tracked);
  void tracked.finally(() => work.delete(tracked));
}

/** Resolves once every tracked observer promise has settled, including ones added meanwhile. */
export async function observersSettled(): Promise<void> {
  while (work.size > 0) await Promise.all(work);
}
