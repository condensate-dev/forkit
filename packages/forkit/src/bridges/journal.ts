/**
 * The fill journal: one JSON file per deposit, so another process can read what a simulator did.
 * A file is written to a temporary name and renamed into place, so a reader never sees half of
 * one. See docs/guides/long-running-stacks.md.
 */
import { mkdirSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Hex } from "viem";

/** A value as JSON holds it. A bigint is written as a decimal string. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** The deposit in a journal file. */
export interface FillJournalDeposit {
  /** `<originChainId>:<txHash>:<logIndex>`. */
  id: string;
  originChainId: number;
  txHash: Hex;
  /** Decimal string. */
  blockNumber: string;
  blockHash: Hex;
  logIndex: number;
  /** Emitting contract. */
  address: Address;
  /** The decoded event args, as the origin contract emitted them. Bigints are decimal strings. */
  args: JsonValue;
}

interface FillJournalBase {
  /** Format version of the file. */
  version: 1;
  /** `across`, `relay`, or the name given to `bridge.custom`. */
  bridge: string;
  /** The key in the file name: the bridge's own id for the deposit. */
  key: string;
  deposit: FillJournalDeposit;
  /** When the file was written, in milliseconds since the epoch. */
  updatedAt: number;
}

/** The fill ran on the destination fork. */
export interface FilledJournalEntry extends FillJournalBase {
  status: "filled";
  destinationChainId: number;
  destinationTxHashes: Hex[];
  /** Amount delivered to the recipient, as a decimal string, when the bridge knows it. */
  outputAmount?: string;
  /** Bridge-specific details of the fill. Bigints are decimal strings. */
  details?: JsonValue;
}

/**
 * The destination chain is not in the fork and `unforkedDestination` is `deliver`. The simulator
 * ran nothing: the deposit counts as delivered, with no transaction.
 */
export interface UnforkedJournalEntry extends FillJournalBase {
  status: "unforked";
  destinationChainId: number;
  destinationTxHashes: [];
}

/** The last attempt to fill the deposit threw. */
export interface FailedJournalEntry extends FillJournalBase {
  status: "failed";
  /** Absent when the bridge could not tell where the deposit goes. */
  destinationChainId?: number;
  error: { name: string; message: string };
  /** How many attempts failed so far. */
  attempts: number;
  /** `true` while the simulator will try again, `false` once it gave the deposit up. */
  retrying: boolean;
}

/** The content of one journal file. Switch on `status`. */
export type FillJournalEntry = FilledJournalEntry | UnforkedJournalEntry | FailedJournalEntry;

/** A value as the journal writes it: bigints become decimal strings, `undefined` is dropped. */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, toJsonValue(v)]),
    );
  }
  return String(value);
}

/** The path of a deposit's journal file: `<dir>/<bridge>-<key>.json`. */
export function fillJournalFile(dir: string, bridge: string, key: string): string {
  // A deposit id holds colons, which are not safe in a file name on every system.
  const safe = (part: string) => part.replace(/[^A-Za-z0-9._-]/g, "-");
  return join(dir, `${safe(bridge)}-${safe(key)}.json`);
}

/** The name and message of anything a fill threw. */
export function journalError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

/** Writes journal files into one directory. */
export interface FillJournal {
  write(entry: FillJournalEntry): Promise<void>;
}

export function openFillJournal(dir: string): FillJournal {
  mkdirSync(dir, { recursive: true });
  let writes = 0;
  return {
    async write(entry) {
      const file = fillJournalFile(dir, entry.bridge, entry.key);
      // The rename is atomic on one file system, so a reader sees the old file or the new one.
      const temporary = `${file}.${process.pid}.${writes++}.tmp`;
      await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`);
      await rename(temporary, file);
    },
  };
}
