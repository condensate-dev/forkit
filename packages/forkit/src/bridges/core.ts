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
  /** Scan the origin forks for new deposits; resolves to the new ones. */
  poll(): Promise<Deposit<TArgs>[]>;
  /** Scan, then fill every pending deposit in order; resolves to the fills this call made. */
  settle(): Promise<Fill<TArgs>[]>;
}

export interface CustomBridgeOptions<TEvent extends AbiEvent, TArgs> {
  /** Name in run events and reports (default `custom`). */
  name?: string;
  /** The deposit event, and the contract(s) emitting it per origin chain id. */
  originEvent: { event: TEvent; address: Readonly<Record<number, Address | readonly Address[]>> };
  /** Destination chain id of a deposit (e.g. from a `destinationChainId` arg). */
  destinationOf: (args: TArgs, originChainId: number) => number | bigint;
  /** Perform the fill on `destination`. */
  onDeposit: (context: FillContext<TArgs>) => Promise<FillResult | undefined>;
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
  const pending: Deposit<TArgs>[] = [];
  const fills: Fill<TArgs>[] = [];
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
      if (d !== undefined && d.originChainId === chainId && !seen.has(d.id)) pending.splice(i, 1);
    }
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

  async function pollNow(): Promise<Deposit<TArgs>[]> {
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
          const deposit: Deposit<TArgs> = {
            id,
            originChainId: chainId,
            destinationChainId: Number(options.destinationOf(args, chainId)),
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            logIndex: log.logIndex,
            address: log.address,
            args,
          };
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

  const poll = () => serialized(pollNow);

  async function settleNow(): Promise<Fill<TArgs>[]> {
    await pollNow();
    const made: Fill<TArgs>[] = [];
    while (pending.length > 0) {
      const deposit = pending[0] as Deposit<TArgs>;
      const destination = handleFor(f, deposit.destinationChainId, "destination");
      const result = await options.onDeposit({
        deposit,
        origin: handleFor(f, deposit.originChainId, "origin"),
        destination,
      });
      pending.shift();
      const fill: Fill<TArgs> = {
        deposit,
        destinationChainId: deposit.destinationChainId,
        txHashes: result?.txHashes ?? [],
        ...(result?.outputAmount === undefined ? {} : { outputAmount: result.outputAmount }),
        ...(result?.details === undefined ? {} : { details: result.details }),
      };
      fills.push(fill);
      emitForkitEvent({
        type: "bridge:fill",
        ts: Date.now(),
        bridge: options.name ?? "custom",
        depositId: deposit.id,
        originChainId: deposit.originChainId,
        destinationChainId: deposit.destinationChainId,
        depositTxHash: deposit.txHash,
        txHashes: fill.txHashes,
        ...(fill.outputAmount === undefined ? {} : { outputAmount: fill.outputAmount }),
        ...(fill.details === undefined ? {} : { details: fill.details }),
      });
      made.push(fill);
    }
    return made;
  }

  return {
    get pending() {
      return [...pending];
    },
    get fills() {
      return [...fills];
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
        .join(", ")}). Fork it with fork([...]).`,
    );
  }
  return member;
}
