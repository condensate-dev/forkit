/**
 * The run record: what one test run did, as `forkit explore` reads it. Plain JSON: every bigint
 * is a decimal string, every address and hash a 0x string. `version` changes on any breaking
 * change to this shape.
 */

export const RUN_RECORD_VERSION = 1;

/** JSON as it is written to disk. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A decimal integer, e.g. a wei amount or gas, serialized from a bigint. */
export type BigIntString = string;

/** A decoded ABI value, with its Solidity type so the UI can render it. */
export interface DecodedParam {
  name: string;
  type: string;
  /**
   * The value: a string for addresses, bytes and integers (decimal), a boolean for `bool`, an
   * array for array types, and a `DecodedParam[]` for a `tuple`.
   */
  value: Json;
}

/** A decoded function call or event. */
export interface DecodedCall {
  name: string;
  /** `transfer(address,uint256)`. */
  signature: string;
  args: DecodedParam[];
}

/** One frame of a transaction's call tree, decoded against known ABIs and labels. */
export interface TraceFrame {
  /** `CALL`, `STATICCALL`, `DELEGATECALL`, `CREATE`, ... */
  type: string;
  from: string;
  to?: string;
  value?: BigIntString;
  gasUsed?: BigIntString;
  input: string;
  output?: string;
  error?: string;
  /** Decoded revert (`Error("…")`, a custom error, a panic), when the frame reverted. */
  revert?: string;
  call?: DecodedCall;
  /** Decoded return values, when the function is known. */
  result?: DecodedParam[];
  calls?: TraceFrame[];
  /**
   * The events this frame emitted itself (not its children's), in order. `position` is how many
   * of `calls` ran before the event, so a UI can interleave events and subcalls.
   */
  logs?: FrameLog[];
}

/** An event emitted by one trace frame. */
export interface FrameLog {
  address: string;
  topics: string[];
  data: string;
  position: number;
  /** The log's index in the receipt, when the node gave it. */
  index?: number;
  event?: DecodedCall;
}

/** One storage slot a transaction wrote. Values are 32-byte hex words. */
export interface SlotDiff {
  slot: string;
  before: string;
  after: string;
  /**
   * What the slot most likely is, found by hashing addresses the run knows with small slot
   * numbers: `balances[alice]` style, e.g. `mapping(9)[alice]` or `mapping(10)[alice][bob]`.
   */
  hint?: string;
}

/** What a transaction changed in one account, from the node's prestate tracer (diff mode). */
export interface AccountDiff {
  address: string;
  balance?: { before: BigIntString; after: BigIntString };
  nonce?: { before: number; after: number };
  /** Code size in bytes before and after (a deployment, a self-destruct, an EIP-7702 delegation). */
  code?: { before: number; after: number };
  storage: SlotDiff[];
}

export interface LogRecord {
  address: string;
  topics: string[];
  data: string;
  logIndex?: number;
  event?: DecodedCall;
}

/** One holder's balance change of one token (or `native`) in one transaction. */
export interface BalanceChange {
  address: string;
  /** Token address, or `native`. */
  token: string;
  delta: BigIntString;
  /** The balance after the transaction's block, when it could be read. */
  after?: BigIntString;
}

export type TxStatus = "success" | "reverted" | "unknown";

export interface TxRecord {
  /** Unique in the run: `<worker>:<n>`. Hashes are not unique (a revert replays the same tx). */
  id: string;
  /** The test it ran in (`TestRecord.key`), or absent for setup/teardown hooks. */
  test?: string;
  worker: string;
  ts: number;
  chainId: number;
  kind: "sendTransaction" | "writeContract" | "deployContract";
  /** Absent when the transaction reverted before it was mined (at estimation). */
  hash?: string;
  /** Whether it was mined (a revert at estimation is not). */
  mined: boolean;
  status: TxStatus;
  from?: string;
  to?: string;
  data?: string;
  value?: BigIntString;
  functionName?: string;
  call?: DecodedCall;
  blockNumber?: BigIntString;
  blockHash?: string;
  blockTimestamp?: number;
  gasUsed?: BigIntString;
  effectiveGasPrice?: BigIntString;
  contractAddress?: string;
  logs: LogRecord[];
  trace?: TraceFrame;
  /** The trace as `forge test -vvvv` prints it. */
  traceText?: string;
  /** The error message, for a reverted transaction. */
  error?: string;
  /** Decoded revert reason, for a reverted transaction. */
  revert?: string;
  balanceChanges: BalanceChange[];
  /** Every account the transaction changed: balance, nonce, code and storage, before and after. */
  stateDiff?: AccountDiff[];
  /** What went wrong while reading the receipt or trace (best effort; the test is unaffected). */
  notes?: string[];
}

export interface ForkRecord {
  worker: string;
  ts: number;
  chainId: number;
  chainName: string;
  nativeSymbol: string;
  blockNumber?: BigIntString;
  upstream: string;
  rpcUrl: string;
  bootMs: number;
  cache?: { mode: string; hits: number; misses: number; entries: number };
}

export interface TestRecord {
  /** Unique in the run: `<worker>:<testId>`. */
  key: string;
  worker: string;
  suite: string;
  name: string;
  status: "pass" | "fail" | "running";
  startedAt: number;
  durationMs?: number;
  error?: string;
  /** A failed expectation's values, rendered, when the assertion error carried both. */
  actual?: string;
  expected?: string;
}

export interface DealRecord {
  test?: string;
  worker: string;
  ts: number;
  chainId: number;
  token: string;
  holder: string;
  amount: BigIntString;
}

export interface FillRecord {
  test?: string;
  worker: string;
  ts: number;
  bridge: string;
  depositId: string;
  originChainId: number;
  destinationChainId: number;
  depositTxHash: string;
  txHashes: string[];
  outputAmount?: BigIntString;
  details?: Json;
}

/** A cheatcode other than `deal` (see `CheatEvent`); bigints as decimal strings. */
export interface CheatRecord {
  test?: string;
  worker: string;
  ts: number;
  chainId: number;
  cheat: "prank" | "stopPrank" | "warp" | "roll" | "snapshot" | "revert";
  account?: string;
  seconds?: BigIntString;
  blocks?: BigIntString;
  snapshotId?: string;
  blockNumber?: BigIntString;
  timestamp?: BigIntString;
}

export interface HttpRecord {
  test?: string;
  worker: string;
  ts: number;
  fixture: string;
  method: string;
  url: string;
  outcome: "hit" | "recorded" | "passthrough" | "unmatched";
}

export interface GasRecord {
  test?: string;
  worker: string;
  ts: number;
  label: string;
  gas: BigIntString;
  mode: "write" | "check" | "off";
  file: string;
  previous?: BigIntString;
}

export interface TokenInfo {
  symbol?: string;
  decimals?: number;
  name?: string;
}

/** What one worker process (or thread) recorded. Merged into a {@link RunRecord}. */
export interface RunPart {
  version: typeof RUN_RECORD_VERSION;
  runId: string;
  worker: string;
  pid: number;
  argv: string[];
  cwd: string;
  startedAt: number;
  updatedAt: number;
  forks: ForkRecord[];
  tests: TestRecord[];
  txs: TxRecord[];
  deals: DealRecord[];
  fills: FillRecord[];
  http: HttpRecord[];
  gas: GasRecord[];
  cheats: CheatRecord[];
  /** Lowercase address to label. */
  labels: Record<string, string>;
  /** `<chainId>:<lowercase token address>` to its metadata. */
  tokens: Record<string, TokenInfo>;
}

export interface BlockRecord {
  chainId: number;
  number: BigIntString;
  hash: string;
  timestamp?: number;
  txs: string[];
}

export interface WorkerRecord {
  worker: string;
  pid: number;
  argv: string[];
  startedAt: number;
  updatedAt: number;
}

/** `.forkit/runs/<id>.json`. */
export interface RunRecord {
  version: typeof RUN_RECORD_VERSION;
  id: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  workers: WorkerRecord[];
  forks: ForkRecord[];
  tests: TestRecord[];
  txs: TxRecord[];
  blocks: BlockRecord[];
  deals: DealRecord[];
  fills: FillRecord[];
  http: HttpRecord[];
  gas: GasRecord[];
  /** Absent in records from forkit before cheats were recorded. */
  cheats?: CheatRecord[];
  labels: Record<string, string>;
  tokens: Record<string, TokenInfo>;
}

/** One row of the run list. */
export interface RunSummary {
  id: string;
  startedAt: number;
  updatedAt: number;
  cwd: string;
  tests: number;
  passed: number;
  failed: number;
  txs: number;
  fills: number;
  chains: { chainId: number; chainName: string }[];
}
