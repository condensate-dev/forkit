/**
 * Simulated cross-chain providers. A bridge simulator watches origin forks for deposit events and,
 * on `settle()`, performs each deposit's fill on its destination fork, the way a relayer or solver
 * would, so cross-chain routes can be tested end to end with no live relayer.
 */
import type { AbiEvent, Address, Chain, Hex, Log } from "viem";
import { parseEventLogs } from "viem";
import { ForkitError } from "../errors.ts";
import { emitForkitEvent } from "../events.ts";
import type { Fork } from "../types.ts";
import { type FillJournalDeposit, journalError, openFillJournal, toJsonValue } from "./journal.ts";

/** A block, by number and hash. */
interface BlockMark {
  number: bigint;
  hash: Hex;
}

/** A deposit seen on an origin fork. */
export interface Deposit<TArgs = Record<string, unknown>> {
  /** `<originChainId>:<txHash>:<logIndex>`. */
  id: string;
  originChainId: number;
  /** Where it is to be filled (resolved by the bridge). */
  destinationChainId: number;
  txHash: Hex;
  blockNumber: bigint;
  /** Hash of the deposit's block, to tell when an `evm_revert` undid it. */
  blockHash: Hex;
  logIndex: number;
  /** Emitting contract. */
  address: Address;
  /** Decoded event args. */
  args: TArgs;
}

/** What a bridge did for one deposit on the destination. */
export interface Fill<TArgs = Record<string, unknown>> {
  deposit: Deposit<TArgs>;
  destinationChainId: number;
  /** Destination transaction(s) that performed the fill. */
  txHashes: Hex[];
  /** Amount delivered to the recipient, when the bridge knows it. */
  outputAmount?: bigint;
  /** Anything bridge-specific worth asserting on (fees, relayer, message handler, ...). */
  details?: Record<string, unknown>;
  /**
   * Set when the destination chain is not in the fork and `unforkedDestination` is `deliver`:
   * the simulator ran nothing, and reports the deposit as delivered with no transaction.
   */
  unforked?: true;
}

/** A deposit the simulator gave up on, after `maxFillAttempts` failed attempts. */
export interface FailedFill<TArgs = Record<string, unknown>> {
  /** The deposit. It has no `destinationChainId` when the bridge could not tell where it goes. */
  deposit: Omit<Deposit<TArgs>, "destinationChainId"> & { destinationChainId?: number };
  /** What the last attempt threw. */
  error: unknown;
  attempts: number;
}

/** What to do with a deposit whose destination chain is not in the fork. */
export type UnforkedDestination = "reject" | "skip" | "deliver";

/** Options of every bridge simulator. A long-running stack sets them; a test rarely does. */
export interface BridgeSimulatorOptions {
  /**
   * Write the outcome of each deposit to `<journalDir>/<bridge>-<key>.json`, so another process
   * can read it. The content is a {@link FillJournalEntry}. Default: no journal.
   */
  journalDir?: string;
  /**
   * How many failed attempts a deposit gets before the simulator gives it up. Default: no limit.
   * A deposit whose fill throws stays pending, holds the deposits behind it, and makes each
   * `settle()` reject, which is right for a test. With a limit, the deposit leaves `pending`
   * after its last failed attempt, goes to `failed`, and is not tried again. The `settle()` that
   * gave it up fills the deposits behind it and then rejects with the error.
   */
  maxFillAttempts?: number;
  /**
   * A deposit whose destination chain is not in the fork. `reject` (the default): its fill
   * fails, under the rule of `maxFillAttempts`. `skip`: the simulator drops it. `deliver`: the
   * simulator records it as a fill with no transaction (`Fill.unforked`).
   */
  unforkedDestination?: UnforkedDestination;
}

/** The options above out of a simulator's own options, to pass them on to `custom()`. */
export function pickSimulatorOptions(options: BridgeSimulatorOptions): BridgeSimulatorOptions {
  return {
    ...(options.journalDir === undefined ? {} : { journalDir: options.journalDir }),
    ...(options.maxFillAttempts === undefined ? {} : { maxFillAttempts: options.maxFillAttempts }),
    ...(options.unforkedDestination === undefined
      ? {}
      : { unforkedDestination: options.unforkedDestination }),
  };
}

/**
 * Thrown by an `onDeposit` to leave its deposit pending and end the settle, with no failed
 * attempt counted. Internal: `bridge.relay` uses it to order fills across its watchers.
 */
export class SettlePaused extends Error {
  override name = "SettlePaused";
}

/** One error as it is; several as an AggregateError that lists each message. */
export function combineErrors(errors: readonly unknown[]): unknown {
  if (errors.length === 1) return errors[0];
  return new AggregateError(
    errors,
    `forkit: ${errors.length} bridge deposits failed:\n${errors
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .join("\n")}`,
  );
}

/** Everything `onDeposit` needs to perform a fill. */
export interface FillContext<TArgs> {
  deposit: Deposit<TArgs>;
  /** The origin chain's handle. */
  origin: Fork;
  /** The destination chain's handle, from the same multi-fork. */
  destination: Fork;
}

/** What `onDeposit` returns: the fill's transactions and, optionally, amounts and details. */
export interface FillResult {
  txHashes?: Hex[];
  outputAmount?: bigint;
  details?: Record<string, unknown>;
}

export interface BridgeSimulator<TArgs = Record<string, unknown>> {
  /** Deposits seen and not filled yet (after the last `poll`/`settle`). */
  readonly pending: readonly Deposit<TArgs>[];
  /** Every fill performed, in order. */
  readonly fills: readonly Fill<TArgs>[];
  /** Every deposit given up, in order. Always empty without `maxFillAttempts`. */
  readonly failed: readonly FailedFill<TArgs>[];
  /** Scan the origin forks for new deposits; resolves to the new ones. */
  poll(): Promise<Deposit<TArgs>[]>;
  /** Scan, then fill every pending deposit in order; resolves to the fills this call made. */
  settle(): Promise<Fill<TArgs>[]>;
}

export interface CustomBridgeOptions<TEvent extends AbiEvent, TArgs>
  extends BridgeSimulatorOptions {
  /** Name in run events and reports (default `custom`). */
  name?: string;
  /** The deposit event, and the contract(s) emitting it per origin chain id. */
  originEvent: { event: TEvent; address: Readonly<Record<number, Address | readonly Address[]>> };
  /** Destination chain id of a deposit (e.g. from a `destinationChainId` arg). */
  destinationOf: (args: TArgs, originChainId: number) => number | bigint;
  /** Perform the fill on `destination`. */
  onDeposit: (context: FillContext<TArgs>) => Promise<FillResult | undefined>;
  /**
   * The key of a deposit in its journal file name: the id another process knows it by, such as
   * an order id. Default: the deposit's `id`.
   */
  journalKey?: (deposit: Omit<Deposit<TArgs>, "destinationChainId">) => string;
}

/**
 * A bridge simulator for any bridge: name the origin deposit event and say how to fill it.
 * `bridge.across` and `bridge.relay` are built on this.
 */
export function custom<const TEvent extends AbiEvent, TArgs = Record<string, unknown>>(
  f: MultiFork,
  options: CustomBridgeOptions<TEvent, TArgs>,
): BridgeSimulator<TArgs> {
  const origins = Object.keys(options.originEvent.address).map(Number);
  for (const chainId of origins) handleFor(f, chainId, "origin");
  const name = options.name ?? "custom";
  const maxAttempts = options.maxFillAttempts ?? Number.POSITIVE_INFINITY;
  if (
    maxAttempts !== Number.POSITIVE_INFINITY &&
    !(Number.isInteger(maxAttempts) && maxAttempts > 0)
  ) {
    throw new ForkitError(
      `forkit: bridge "${name}" maxFillAttempts is ${maxAttempts}; pass a whole number, 1 or more, or omit it for no limit.`,
    );
  }
  const unforked = options.unforkedDestination ?? "reject";
  const journal =
    options.journalDir === undefined ? undefined : openFillJournal(options.journalDir);
  const pending: Deposit<TArgs>[] = [];
  const fills: Fill<TArgs>[] = [];
  const failed: FailedFill<TArgs>[] = [];
  /** Failed attempts so far, by deposit id, for the deposits not given up yet. */
  const attempts = new Map<string, number>();
  // Per origin chain: the block scanning started at and the last block scanned, each with its
  // hash; and every deposit seen, with its block. Heights alone cannot tell that a chain was
  // reverted and re-mined back to (or past) the same height; hashes can.
  const startedAt = new Map<number, BlockMark>();
  const scanned = new Map<number, BlockMark>();
  const seen = new Map<string, BlockMark & { chainId: number }>();

  const headOf = async (origin: Fork): Promise<BlockMark> => {
    const block = await origin.client.getBlock();
    return { number: block.number, hash: block.hash };
  };
  const hashAt = async (origin: Fork, number: bigint): Promise<Hex | undefined> => {
    try {
      return (await origin.client.getBlock({ blockNumber: number })).hash;
    } catch {
      return undefined; // above the head after a revert
    }
  };
  const forget = (chainId: number, keep: (mark: BlockMark) => boolean) => {
    for (const [id, mark] of seen) if (mark.chainId === chainId && !keep(mark)) seen.delete(id);
    for (let i = pending.length - 1; i >= 0; i--) {
      const d = pending[i];
      if (d !== undefined && d.originChainId === chainId && !seen.has(d.id)) {
        pending.splice(i, 1);
        attempts.delete(d.id);
      }
    }
  };

  const journalBase = (deposit: FailedFill<TArgs>["deposit"]) => {
    const journaled: FillJournalDeposit = {
      id: deposit.id,
      originChainId: deposit.originChainId,
      txHash: deposit.txHash,
      blockNumber: deposit.blockNumber.toString(),
      blockHash: deposit.blockHash,
      logIndex: deposit.logIndex,
      address: deposit.address,
      args: toJsonValue(deposit.args),
    };
    return {
      version: 1 as const,
      bridge: name,
      key: options.journalKey?.(deposit) ?? deposit.id,
      deposit: journaled,
      updatedAt: Date.now(),
    };
  };

  /** Count a failed attempt and journal it. Resolves to whether the deposit is given up. */
  const failedAttempt = async (
    deposit: FailedFill<TArgs>["deposit"],
    error: unknown,
  ): Promise<boolean> => {
    const count = (attempts.get(deposit.id) ?? 0) + 1;
    const givenUp = count >= maxAttempts;
    if (givenUp) {
      attempts.delete(deposit.id);
      failed.push({ deposit, error, attempts: count });
    } else {
      attempts.set(deposit.id, count);
    }
    await journal?.write({
      ...journalBase(deposit),
      status: "failed",
      ...(deposit.destinationChainId === undefined
        ? {}
        : { destinationChainId: deposit.destinationChainId }),
      error: journalError(error),
      attempts: count,
      retrying: !givenUp,
    });
    return givenUp;
  };

  // Deposits made before the simulator existed are ignored: scanning starts at the head.
  const started = Promise.all(
    origins.map(async (chainId) => {
      const head = await headOf(handleFor(f, chainId, "origin"));
      startedAt.set(chainId, head);
      scanned.set(chainId, head);
    }),
  );
  // A failed start surfaces from the next poll/settle, not as an unhandled rejection.
  started.catch(() => {});

  // `errors` collects the error of each deposit given up, so the caller can do the rest of its
  // work before it rejects. A deposit that will be tried again stops the scan with a throw.
  async function pollNow(errors: unknown[]): Promise<Deposit<TArgs>[]> {
    await started;
    const found: Deposit<TArgs>[] = [];
    for (const chainId of origins) {
      const origin = handleFor(f, chainId, "origin");
      const head = await headOf(origin);
      const last = scanned.get(chainId) as BlockMark;
      const first = startedAt.get(chainId) as BlockMark;
      let from = last.number;
      if ((await hashAt(origin, last.number)) !== last.hash) {
        // The chain changed under us (an evm_revert, maybe re-mined since).
        if ((await hashAt(origin, first.number)) !== first.hash) {
          // Reverted to before the simulator existed: nothing seen survives; start over here.
          forget(chainId, () => false);
          startedAt.set(chainId, head);
          scanned.set(chainId, head);
          continue;
        }
        // Keep the deposits whose blocks are still on chain, forget the rest, rescan.
        const hashes = new Map<bigint, Hex | undefined>();
        for (const mark of seen.values()) {
          if (mark.chainId === chainId && !hashes.has(mark.number)) {
            hashes.set(mark.number, await hashAt(origin, mark.number));
          }
        }
        forget(chainId, (mark) => hashes.get(mark.number) === mark.hash);
        from = first.number;
      }
      if (head.number > from) {
        const addresses = [options.originEvent.address[chainId] ?? []].flat() as Address[];
        const logs = await origin.client.getLogs({
          address: addresses,
          event: options.originEvent.event,
          fromBlock: from + 1n,
          toBlock: head.number,
        });
        const parsed = parseEventLogs({ abi: [options.originEvent.event], logs: logs as Log[] });
        for (const log of parsed) {
          if (
            log.transactionHash === null ||
            log.blockNumber === null ||
            log.blockHash === null ||
            log.logIndex === null
          )
            continue;
          const id = `${chainId}:${log.transactionHash}:${log.logIndex}`;
          if (seen.has(id)) continue;
          const args = (log as { args: unknown }).args as TArgs;
          const unrouted = {
            id,
            originChainId: chainId,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            logIndex: log.logIndex,
            address: log.address,
            args,
          };
          let destinationChainId: number;
          try {
            destinationChainId = Number(options.destinationOf(args, chainId));
          } catch (error) {
            // The bridge cannot tell where the deposit goes yet (bridge.relay: no fill is
            // registered for its order). Until it is given up it stays unread, so that a later
            // poll finds it again.
            errors.push(error);
            if (!(await failedAttempt(unrouted, error))) throw combineErrors(errors);
            seen.set(id, { chainId, number: log.blockNumber, hash: log.blockHash });
            continue;
          }
          const deposit: Deposit<TArgs> = { ...unrouted, destinationChainId };
          seen.set(id, { chainId, number: log.blockNumber, hash: log.blockHash });
          pending.push(deposit);
          found.push(deposit);
        }
      }
      scanned.set(chainId, head);
    }
    return found;
  }

  // poll and settle run one at a time, so two concurrent settles cannot fill one deposit twice.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  const poll = () =>
    serialized(async () => {
      const errors: unknown[] = [];
      const found = await pollNow(errors);
      if (errors.length > 0) throw combineErrors(errors);
      return found;
    });

  /** Fill one deposit. Resolves to `undefined` for a deposit that `unforkedDestination` skips. */
  async function fillOne(deposit: Deposit<TArgs>): Promise<Fill<TArgs> | undefined> {
    if (!f.forks.some((m) => m.chain.id === deposit.destinationChainId)) {
      switch (unforked) {
        case "skip":
          return undefined;
        case "deliver":
          return {
            deposit,
            destinationChainId: deposit.destinationChainId,
            txHashes: [],
            unforked: true,
          };
        case "reject":
          break; // handleFor below throws, and names the chain.
        default: {
          const policy: never = unforked;
          throw new ForkitError(`forkit: unknown unforkedDestination ${JSON.stringify(policy)}`);
        }
      }
    }
    const destination = handleFor(f, deposit.destinationChainId, "destination");
    const result = await options.onDeposit({
      deposit,
      origin: handleFor(f, deposit.originChainId, "origin"),
      destination,
    });
    return {
      deposit,
      destinationChainId: deposit.destinationChainId,
      txHashes: result?.txHashes ?? [],
      ...(result?.outputAmount === undefined ? {} : { outputAmount: result.outputAmount }),
      ...(result?.details === undefined ? {} : { details: result.details }),
    };
  }

  async function settleNow(): Promise<Fill<TArgs>[]> {
    const errors: unknown[] = [];
    await pollNow(errors);
    const made: Fill<TArgs>[] = [];
    while (pending.length > 0) {
      const deposit = pending[0] as Deposit<TArgs>;
      let fill: Fill<TArgs> | undefined;
      try {
        fill = await fillOne(deposit);
      } catch (error) {
        if (error instanceof SettlePaused) {
          if (errors.length === 0) throw error;
          break;
        }
        errors.push(error);
        // A deposit with attempts left holds the ones behind it, so fills keep their order.
        if (!(await failedAttempt(deposit, error))) break;
        pending.shift();
        continue;
      }
      pending.shift();
      attempts.delete(deposit.id);
      if (fill === undefined) continue;
      fills.push(fill);
      emitForkitEvent({
        type: "bridge:fill",
        ts: Date.now(),
        bridge: name,
        depositId: deposit.id,
        originChainId: deposit.originChainId,
        destinationChainId: deposit.destinationChainId,
        depositTxHash: deposit.txHash,
        txHashes: fill.txHashes,
        ...(fill.outputAmount === undefined ? {} : { outputAmount: fill.outputAmount }),
        ...(fill.details === undefined ? {} : { details: fill.details }),
      });
      made.push(fill);
      const base = journalBase(deposit);
      await journal?.write(
        fill.unforked === true
          ? {
              ...base,
              status: "unforked",
              destinationChainId: fill.destinationChainId,
              destinationTxHashes: [],
            }
          : {
              ...base,
              status: "filled",
              destinationChainId: fill.destinationChainId,
              destinationTxHashes: fill.txHashes,
              ...(fill.outputAmount === undefined
                ? {}
                : { outputAmount: fill.outputAmount.toString() }),
              ...(fill.details === undefined ? {} : { details: toJsonValue(fill.details) }),
            },
      );
    }
    if (errors.length > 0) throw combineErrors(errors);
    return made;
  }

  return {
    get pending() {
      return [...pending];
    },
    get fills() {
      return [...fills];
    },
    get failed() {
      return [...failed];
    },
    poll,
    settle: () => serialized(settleNow),
  };
}

/** Any fork handle (single or multi-chain); a bridge only needs its per-chain handles. */
export interface MultiFork {
  readonly forks: readonly Fork[];
}

/** The handle for `chainId` in a multi-fork, with an error naming the role when it is missing. */
export function handleFor(f: MultiFork, chainId: number, role: "origin" | "destination"): Fork {
  const member = f.forks.find((m) => m.chain.id === chainId);
  if (member === undefined) {
    throw new ForkitError(
      `forkit: the bridge's ${role} chain ${chainId} is not in this fork (${f.forks
        .map((m: Fork<Chain>) => `${m.chain.name} (${m.chain.id})`)
        .join(", ")}). Fork it with fork([...])${
        role === "destination"
          ? ', or pass unforkedDestination: "skip" or "deliver" to the simulator'
          : ""
      }.`,
    );
  }
  return member;
}
