/**
 * The run recorder: turns this process's run events into a part of a run record. Transactions
 * are enriched while the fork still has them (receipt, block, decoded call, logs, call trace,
 * balance changes); the fork waits for that before an `evm_revert` or a stop (see
 * `trackObserverWork`). Every step is best effort: recording never fails a test.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Address,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  http,
  numberToHex,
  parseAbi,
  zeroAddress,
} from "viem";
import { type RawRequest, rawRequest } from "../client.ts";
import { type ForkitEvent, observersSettled, onForkitEvent, trackObserverWork } from "../events.ts";
import { allLabels } from "../labels.ts";
import {
  CALL_TRACER_WITH_LOGS,
  type CallFrame,
  formatTrace,
  PRESTATE_DIFF,
  traceCall,
  traceCallWith,
  traceTransaction,
  traceTransactionWith,
} from "../trace.ts";
import { decodeCall, decodeFrame, logRecord, revertText } from "./decode.ts";
import { toJson } from "./json.ts";
import type {
  BalanceChange,
  DecodedParam,
  Json,
  RunPart,
  TokenInfo,
  TraceFrame,
  TxRecord,
} from "./schema.ts";
import { type PrestateDiff, SlotNamer, stateDiff } from "./state.ts";
import {
  appendPart,
  applyLine,
  emptyPart,
  mergeRun,
  type PartLine,
  type PartMeta,
  partFile,
  recordDir,
  resolveRunId,
  touchRunPointer,
  workerName,
} from "./store.ts";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const METADATA_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
]);
const RECEIPT_WAIT_MS = 5_000;
const ENRICH_TIMEOUT_MS = 20_000;
/** Quiet time after a test or transaction before the run file is re-merged. */
const MERGE_DELAY_MS = 1_000;
/** Balance reads per transaction, at most. */
const MAX_BALANCE_READS = 32;

export interface RecorderOptions {
  /** Record directory (default `FORKIT_RECORD_DIR`, else `.forkit` in the working directory). */
  dir?: string;
  /** Run id (default `FORKIT_RUN_ID`, else shared by the test runner's workers). */
  runId?: string;
  /** Write the part file (default `true`). `false` keeps the record in memory only. */
  write?: boolean;
  /** Read receipts, traces and balances from the fork (default `true`). */
  enrich?: boolean;
  /** JSON-RPC to a fork, by its URL. Tests inject a fake. */
  request?: (rpcUrl: string) => RawRequest;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

interface Receipt {
  status: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  gasUsed: Hex;
  effectiveGasPrice?: Hex;
  contractAddress?: Address | null;
  logs: { address: Address; topics: Hex[]; data: Hex; logIndex?: Hex | null }[];
}

/** Net balance changes of a transaction: native value moved in its trace, gas, ERC-20 Transfers. */
export function balanceChanges(
  trace: CallFrame | undefined,
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  from: string | undefined,
  fee: bigint,
): BalanceChange[] {
  const deltas = new Map<string, bigint>();
  const add = (address: string, token: string, amount: bigint) => {
    const holder = address.toLowerCase();
    if (holder === zeroAddress || amount === 0n) return;
    const key = `${holder}|${token}`;
    deltas.set(key, (deltas.get(key) ?? 0n) + amount);
  };
  const walk = (frame: CallFrame) => {
    if (frame.error !== undefined) return; // Reverted: none of its value moved.
    const type = frame.type.toUpperCase();
    const value = frame.value === undefined ? 0n : BigInt(frame.value);
    if (value > 0n && type !== "DELEGATECALL" && type !== "STATICCALL" && frame.to !== undefined) {
      add(frame.from, "native", -value);
      add(frame.to, "native", value);
    }
    for (const child of frame.calls ?? []) walk(child);
  };
  if (trace !== undefined) walk(trace);
  if (from !== undefined && fee > 0n) add(from, "native", -fee);
  for (const log of logs) {
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.data.length !== 66) continue; // ERC-721 Transfer indexes the id instead.
    const amount = BigInt(log.data);
    const token = log.address.toLowerCase();
    add(`0x${(log.topics[1] as string).slice(26)}`, token, -amount);
    add(`0x${(log.topics[2] as string).slice(26)}`, token, amount);
  }
  return [...deltas]
    .filter(([, delta]) => delta !== 0n)
    .map(([key, delta]) => {
      const [address, token] = key.split("|") as [string, string];
      return { address, token, delta: delta.toString() };
    });
}

export class RunRecorder {
  readonly part: RunPart;
  readonly dir: string;
  readonly #file: string | undefined;
  readonly #enrich: boolean;
  readonly #request: (rpcUrl: string) => RawRequest;
  readonly #clients = new Map<string, RawRequest>();
  readonly #tokenReads = new Map<string, Promise<void>>();
  /**
   * Forks on an offline cache, by URL. Their recording holds only what the tests read, so reading
   * token metadata there would miss it, and fail the run for a read no test made.
   */
  readonly #offline = new Set<string>();
  #current: string | undefined;
  #txCount = 0;
  #labels = "{}";
  #wrote = false;
  #unsubscribe: (() => void) | undefined;
  #mergeTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #namer = new SlotNamer();

  constructor(options: RecorderOptions = {}) {
    this.dir = options.dir ?? recordDir();
    const runId = options.runId ?? resolveRunId(this.dir);
    const worker = workerName();
    const now = Date.now();
    this.part = emptyPart({
      version: 1,
      runId,
      worker,
      pid: process.pid,
      argv: process.argv.slice(1),
      cwd: process.cwd(),
      startedAt: now,
      updatedAt: now,
    });
    this.#file = options.write === false ? undefined : partFile(this.dir, runId, worker);
    this.#enrich = options.enrich ?? true;
    this.#request =
      options.request ??
      ((url) => {
        let request = this.#clients.get(url);
        if (request === undefined) {
          request = rawRequest(
            createPublicClient({ transport: http(url, { timeout: 10_000, retryCount: 1 }) }),
          );
          this.#clients.set(url, request);
        }
        return request;
      });
  }

  get runId(): string {
    return this.part.runId;
  }

  /** Subscribe to run events. Idempotent. */
  start(): this {
    this.#unsubscribe ??= onForkitEvent((event) => this.handle(event));
    return this;
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Apply lines to the in-memory part and append them to the part file. */
  #write(lines: PartLine[]): void {
    this.part.updatedAt = Date.now();
    for (const line of lines) applyLine(this.part, line);
    if (this.#file === undefined) return;
    try {
      if (!this.#wrote) mkdirSync(dirname(this.#file), { recursive: true });
      // The meta line first, and again with each test's end (it carries updatedAt).
      const meta = !this.#wrote || lines.some((l) => l.kind === "test");
      appendPart(this.#file, meta ? [{ kind: "meta", meta: this.#meta() }, ...lines] : lines);
      this.#wrote = true;
      touchRunPointer(this.dir);
      if (lines.some((l) => l.kind === "test" || l.kind === "tx")) this.#scheduleMerge();
    } catch {
      // A read-only or full disk must not fail the test run.
    }
  }

  #meta(): PartMeta {
    const { runId, worker, pid, argv, cwd, startedAt, updatedAt } = this.part;
    return { version: 1, runId, worker, pid, argv, cwd, startedAt, updatedAt };
  }

  /** Record labels that changed since the last time. */
  #syncLabels(): PartLine[] {
    const labels = allLabels();
    const text = JSON.stringify(labels);
    if (text === this.#labels) return [];
    this.#labels = text;
    return [{ kind: "labels", labels }];
  }

  #track(work: () => Promise<void>): void {
    if (!this.#enrich) return;
    trackObserverWork(withTimeout(work(), ENRICH_TIMEOUT_MS, "forkit run record").catch(() => {}));
  }

  /** Handle one run event. */
  handle(event: ForkitEvent): void {
    const test = this.#current;
    const base = {
      ...(test === undefined ? {} : { test }),
      worker: this.part.worker,
      ts: event.ts,
    };
    switch (event.type) {
      case "test:start": {
        const key = `${this.part.worker}:${event.testId}`;
        this.#current = key;
        this.#write([
          {
            kind: "test",
            record: {
              key,
              worker: this.part.worker,
              suite: event.suite,
              name: event.name,
              status: "running",
              startedAt: event.ts,
            },
          },
        ]);
        return;
      }
      case "test:end": {
        const key = `${this.part.worker}:${event.testId}`;
        this.#current = undefined;
        const started = this.part.tests.find((t) => t.key === key);
        this.#write([
          ...this.#syncLabels(),
          {
            kind: "test",
            record: {
              key,
              worker: this.part.worker,
              suite: event.suite,
              name: event.name,
              status: event.status,
              startedAt: started?.startedAt ?? event.ts - event.durationMs,
              durationMs: event.durationMs,
              ...(event.error === undefined ? {} : { error: event.error }),
              ...(event.actual === undefined ? {} : { actual: event.actual }),
              ...(event.expected === undefined ? {} : { expected: event.expected }),
            },
          },
        ]);
        return;
      }
      case "fork:boot":
        if (event.cache?.mode === "offline") this.#offline.add(event.rpcUrl);
        else this.#offline.delete(event.rpcUrl);
        this.#write([
          {
            kind: "fork",
            record: {
              worker: this.part.worker,
              ts: event.ts,
              chainId: event.chainId,
              chainName: event.chainName,
              nativeSymbol: event.nativeSymbol ?? "ETH",
              ...(event.blockNumber === undefined
                ? {}
                : { blockNumber: event.blockNumber.toString() }),
              upstream: event.upstream,
              rpcUrl: event.rpcUrl,
              bootMs: event.bootMs,
              ...(event.cache === undefined
                ? {}
                : {
                    cache: {
                      mode: event.cache.mode,
                      hits: event.cache.hits,
                      misses: event.cache.misses,
                      entries: event.cache.entries,
                    },
                  }),
            },
          },
        ]);
        return;
      case "tx:sent":
      case "tx:reverted": {
        const sent = event.type === "tx:sent";
        const decoded = decodeCall(event.data);
        const tx: TxRecord = {
          id: `${this.part.worker}:${++this.#txCount}`,
          ...base,
          chainId: event.chainId,
          kind: event.kind,
          ...(sent ? { hash: event.hash } : {}),
          mined: sent,
          status: sent ? "unknown" : "reverted",
          ...(event.from === undefined ? {} : { from: event.from.toLowerCase() }),
          ...(event.to === undefined ? {} : { to: event.to.toLowerCase() }),
          ...(event.data === undefined ? {} : { data: event.data }),
          ...(event.value === undefined ? {} : { value: event.value.toString() }),
          ...(event.functionName === undefined ? {} : { functionName: event.functionName }),
          ...(decoded === undefined ? {} : { call: decoded }),
          ...(sent ? {} : { error: event.message }),
          ...(!sent && event.trace !== undefined ? { traceText: event.trace } : {}),
          logs: [],
          balanceChanges: [],
        };
        this.#write([{ kind: "tx", record: tx }]);
        const request = this.#request(event.rpcUrl);
        const readTokens = !this.#offline.has(event.rpcUrl);
        this.#track(async () => {
          const enriched = sent
            ? await this.#enrichMined(request, tx, event.hash, readTokens)
            : await this.#enrichReverted(request, tx, event.value);
          this.#write([...this.#syncLabels(), { kind: "tx", record: enriched }]);
        });
        return;
      }
      case "deal": {
        const token = event.token === "native" ? "native" : event.token.toLowerCase();
        this.#write([
          {
            kind: "deal",
            record: {
              ...base,
              chainId: event.chainId,
              token,
              holder: event.holder.toLowerCase(),
              amount: event.amount.toString(),
            },
          },
        ]);
        if (token !== "native" && !this.#offline.has(event.rpcUrl)) {
          const request = this.#request(event.rpcUrl);
          this.#track(() => this.#readTokens(request, event.chainId, [token]));
        }
        return;
      }
      case "bridge:fill":
        this.#write([
          {
            kind: "fill",
            record: {
              ...base,
              bridge: event.bridge,
              depositId: event.depositId,
              originChainId: event.originChainId,
              destinationChainId: event.destinationChainId,
              depositTxHash: event.depositTxHash,
              txHashes: [...event.txHashes],
              ...(event.outputAmount === undefined
                ? {}
                : { outputAmount: event.outputAmount.toString() }),
              ...(event.details === undefined ? {} : { details: toJson(event.details) }),
            },
          },
        ]);
        return;
      case "http:request":
        this.#write([
          {
            kind: "http",
            record: {
              ...base,
              fixture: event.fixture,
              method: event.method,
              url: event.url,
              outcome: event.outcome,
            },
          },
        ]);
        return;
      case "gas:snapshot":
        this.#write([
          {
            kind: "gas",
            record: {
              ...base,
              label: event.label,
              gas: event.gas.toString(),
              mode: event.mode,
              file: event.file,
              ...(event.previous === undefined ? {} : { previous: event.previous.toString() }),
            },
          },
        ]);
        return;
      case "cheat":
        this.#write([
          {
            kind: "cheat",
            record: {
              ...base,
              chainId: event.chainId,
              cheat: event.cheat,
              ...(event.account === undefined ? {} : { account: event.account.toLowerCase() }),
              ...(event.seconds === undefined ? {} : { seconds: event.seconds.toString() }),
              ...(event.blocks === undefined ? {} : { blocks: event.blocks.toString() }),
              ...(event.snapshotId === undefined ? {} : { snapshotId: event.snapshotId }),
              ...(event.blockNumber === undefined
                ? {}
                : { blockNumber: event.blockNumber.toString() }),
              ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp.toString() }),
            },
          },
        ]);
        return;
      default:
        // An event type this recorder does not know yet (a newer forkit): nothing to record.
        return;
    }
  }

  async #enrichMined(
    request: RawRequest,
    tx: TxRecord,
    hash: Hex,
    readTokens: boolean,
  ): Promise<TxRecord> {
    const out: TxRecord = { ...tx, logs: [], balanceChanges: [] };
    const notes: string[] = [];
    let receipt: Receipt | null = null;
    const deadline = Date.now() + RECEIPT_WAIT_MS;
    try {
      while (receipt === null && Date.now() < deadline) {
        receipt = (await request({
          method: "eth_getTransactionReceipt",
          params: [hash],
        })) as Receipt | null;
        if (receipt === null) await new Promise((ok) => setTimeout(ok, 20));
      }
      if (receipt === null)
        notes.push("no receipt: the fork never reported this transaction mined");
    } catch (error) {
      notes.push(`receipt: ${messageOf(error)}`);
    }
    let fee = 0n;
    if (receipt !== null) {
      out.status = receipt.status === "0x1" ? "success" : "reverted";
      out.blockNumber = BigInt(receipt.blockNumber).toString();
      out.blockHash = receipt.blockHash;
      out.gasUsed = BigInt(receipt.gasUsed).toString();
      if (receipt.effectiveGasPrice !== undefined) {
        out.effectiveGasPrice = BigInt(receipt.effectiveGasPrice).toString();
        fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      }
      if (receipt.contractAddress !== undefined && receipt.contractAddress !== null) {
        out.contractAddress = receipt.contractAddress.toLowerCase();
      }
      out.logs = receipt.logs.map(logRecord);
      try {
        const block = (await request({
          method: "eth_getBlockByHash",
          params: [receipt.blockHash, false],
        })) as { timestamp: Hex } | null;
        if (block !== null) out.blockTimestamp = Number(BigInt(block.timestamp));
      } catch {
        // The block time is a nicety.
      }
    }
    let frame: CallFrame | undefined;
    try {
      // With each frame's events; a node without `withLog` gets the plain call tree.
      frame = await traceTransactionWith<CallFrame>(request, hash, CALL_TRACER_WITH_LOGS).catch(
        () => traceTransaction(request, hash),
      );
      out.trace = decodeFrame(frame);
      out.traceText = formatTrace(frame);
      if (frame.error !== undefined) out.revert = revertText(frame);
    } catch (error) {
      notes.push(`trace: ${messageOf(error)}`);
    }
    try {
      const diff = await traceTransactionWith<PrestateDiff>(request, hash, PRESTATE_DIFF);
      out.stateDiff = stateDiff(diff, this.#slotNamer(out));
    } catch (error) {
      notes.push(`state diff: ${messageOf(error)}`);
    }
    if (receipt !== null) {
      out.balanceChanges = balanceChanges(frame, receipt.logs, tx.from, fee);
      await this.#readBalances(request, out.balanceChanges, receipt.blockNumber);
      if (readTokens) {
        await this.#readTokens(
          request,
          tx.chainId,
          out.balanceChanges.map((c) => c.token),
        );
      }
    }
    if (notes.length > 0) out.notes = notes;
    return out;
  }

  async #enrichReverted(
    request: RawRequest,
    tx: TxRecord,
    value: bigint | undefined,
  ): Promise<TxRecord> {
    const out: TxRecord = { ...tx };
    try {
      const call = {
        ...(tx.from === undefined ? {} : { from: tx.from as Address }),
        ...(tx.to === undefined ? {} : { to: tx.to as Address }),
        ...(tx.data === undefined ? {} : { data: tx.data as Hex }),
        ...(value === undefined ? {} : { value: numberToHex(value) }),
      };
      const frame = await traceCallWith<CallFrame>(
        request,
        call,
        "latest",
        CALL_TRACER_WITH_LOGS,
      ).catch(() => traceCall(request, call));
      out.trace = decodeFrame(frame);
      out.traceText ??= formatTrace(frame);
      if (frame.error !== undefined) out.revert = revertText(frame);
      if (frame.gasUsed !== undefined) out.gasUsed = BigInt(frame.gasUsed).toString();
    } catch (error) {
      out.notes = [`trace: ${messageOf(error)}`];
    }
    return out;
  }

  /**
   * Names for storage slots: every labelled address, and every address in the transaction's
   * trace, its decoded arguments and its events, hashed into mapping slots (see `SlotNamer`).
   * One namer for the whole run.
   */
  #slotNamer(tx: TxRecord): SlotNamer {
    const namer = this.#namer;
    for (const [address, name] of Object.entries(allLabels())) namer.add(address, name);
    const add = (address: string | undefined) => {
      if (address !== undefined && /^0x[0-9a-fA-F]{40}$/.test(address)) namer.add(address);
    };
    const params = (list: readonly DecodedParam[] | undefined) => {
      for (const param of list ?? []) addresses(param.type, param.value);
    };
    const addresses = (type: string, value: Json) => {
      if (type === "address" && typeof value === "string") add(value);
      else if (type === "bytes32" && typeof value === "string" && /^0x0{24}/.test(value))
        add(`0x${value.slice(26)}`);
      else if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== null && typeof item === "object" && "type" in item && !Array.isArray(item))
            addresses(String(item.type), (item as { value: Json }).value);
          else addresses(type.replace(/\[\d*\]$/, ""), item);
        }
      }
    };
    const walk = (frame: TraceFrame) => {
      add(frame.from);
      add(frame.to);
      params(frame.call?.args);
      for (const log of frame.logs ?? []) params(log.event?.args);
      for (const child of frame.calls ?? []) walk(child);
    };
    add(tx.from);
    add(tx.to);
    params(tx.call?.args);
    for (const log of tx.logs) params(log.event?.args);
    if (tx.trace !== undefined) walk(tx.trace);
    return namer;
  }

  /** Each changed balance after the transaction's block. */
  async #readBalances(request: RawRequest, changes: BalanceChange[], block: Hex): Promise<void> {
    await Promise.all(
      changes.slice(0, MAX_BALANCE_READS).map(async (change) => {
        try {
          const result =
            change.token === "native"
              ? ((await request({
                  method: "eth_getBalance",
                  params: [change.address, block],
                })) as Hex)
              : ((await request({
                  method: "eth_call",
                  params: [
                    {
                      to: change.token,
                      data: encodeFunctionData({
                        abi: erc20Abi,
                        functionName: "balanceOf",
                        args: [change.address as Address],
                      }),
                    },
                    block,
                  ],
                })) as Hex);
          change.after = BigInt(result).toString();
        } catch {
          // History before this block may be gone (a revert); the delta still stands.
        }
      }),
    );
  }

  /** Symbol, decimals and name of tokens not read yet. */
  #readTokens(request: RawRequest, chainId: number, tokens: readonly string[]): Promise<void> {
    const reads = [...new Set(tokens)]
      .filter((token) => token !== "native")
      .map((token) => {
        const key = `${chainId}:${token}`;
        let read = this.#tokenReads.get(key);
        if (read === undefined) {
          read = this.#readToken(request, token as Address).then((info) => {
            if (Object.keys(info).length > 0) this.#write([{ kind: "token", key, info }]);
          });
          this.#tokenReads.set(key, read);
        }
        return read;
      });
    return Promise.all(reads).then(() => {});
  }

  async #readToken(request: RawRequest, token: Address): Promise<TokenInfo> {
    const read = async (functionName: "symbol" | "decimals" | "name"): Promise<unknown> => {
      const data = (await request({
        method: "eth_call",
        params: [
          { to: token, data: encodeFunctionData({ abi: METADATA_ABI, functionName }) },
          "latest",
        ],
      })) as Hex;
      return decodeFunctionResult({ abi: METADATA_ABI, functionName, data });
    };
    const [symbol, decimals, name] = await Promise.allSettled([
      read("symbol"),
      read("decimals"),
      read("name"),
    ]);
    return {
      ...(symbol.status === "fulfilled" ? { symbol: String(symbol.value) } : {}),
      ...(decimals.status === "fulfilled" ? { decimals: Number(decimals.value) } : {}),
      ...(name.status === "fulfilled" ? { name: String(name.value) } : {}),
    };
  }

  /**
   * Merge soon after activity settles. Runners may kill workers without an `exit` event, so
   * waiting for exit alone could leave `runs/<id>.json` stale (readers re-merge anyway).
   */
  #scheduleMerge(): void {
    if (this.#mergeTimer !== undefined) return;
    this.#mergeTimer = setTimeout(() => {
      this.#mergeTimer = undefined;
      this.merge();
    }, MERGE_DELAY_MS);
    this.#mergeTimer.unref?.();
  }

  /**
   * Merge this run's parts (every worker's, not just this one's) into `runs/<id>.json`. A
   * recorder that wrote nothing still merges: in a global setup, it outlives the workers.
   */
  merge(): void {
    if (this.#file === undefined) return;
    try {
      mergeRun(this.dir, this.part.runId);
    } catch {
      // `forkit explore` merges again when it opens the run.
    }
  }
}

let active: RunRecorder | undefined;

/**
 * Record this process's run events into `.forkit/runs/<id>.json` (see docs/guides/explore.md).
 * Idempotent: a second call returns the recorder already running.
 */
export function startRecording(options: RecorderOptions = {}): RunRecorder {
  if (active !== undefined) return active;
  const recorder = new RunRecorder(options).start();
  active = recorder;
  process.once("exit", () => recorder.merge());
  return recorder;
}

/** Stop recording and merge what was recorded. */
export async function stopRecording(): Promise<void> {
  const recorder = active;
  if (recorder === undefined) return;
  active = undefined;
  recorder.stop();
  await observersSettled();
  recorder.merge();
}

/** The recorder `startRecording` started, if any. */
export function activeRecorder(): RunRecorder | undefined {
  return active;
}
