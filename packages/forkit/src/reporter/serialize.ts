/**
 * A run log, and its JSON form. Events cross process boundaries (vitest workers to the reporter
 * in the main process) as JSON, where bigints travel as `{ "$bigint": "123" }`.
 */
import type { ForkitEvent } from "../events.ts";

/** What the ERC-20 at an address calls itself. */
export interface TokenInfo {
  symbol?: string;
  decimals?: number;
}

/** Events plus what is needed to render them away from the process that emitted them. */
export interface RunLog {
  events: ForkitEvent[];
  /** Labels (see `label()`) of the addresses in `events`, by lowercase address. */
  labels: Record<string, string>;
  /** ERC-20 metadata by `<chainId>:<lowercase address>`. */
  tokens: Record<string, TokenInfo>;
}

export const tokenKey = (chainId: number, address: string): string =>
  `${chainId}:${address.toLowerCase()}`;

const BIGINT = "$bigint";

/** JSON for a run log, bigint-safe. */
export function serializeRunLog(log: RunLog): string {
  return JSON.stringify(log, (_key, value: unknown) =>
    typeof value === "bigint" ? { [BIGINT]: value.toString() } : value,
  );
}

/** The inverse of {@link serializeRunLog}. */
export function parseRunLog(text: string): RunLog {
  const parsed = JSON.parse(text, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const keys = Object.keys(value);
      const raw = (value as Record<string, unknown>)[BIGINT];
      if (keys.length === 1 && typeof raw === "string") return BigInt(raw);
    }
    return value;
  }) as Partial<RunLog>;
  return { events: parsed.events ?? [], labels: parsed.labels ?? {}, tokens: parsed.tokens ?? {} };
}

/** Concatenate run logs in order; later labels and token metadata win. */
export function mergeRunLogs(logs: readonly RunLog[]): RunLog {
  const merged: RunLog = { events: [], labels: {}, tokens: {} };
  for (const log of logs) {
    merged.events.push(...log.events);
    Object.assign(merged.labels, log.labels);
    Object.assign(merged.tokens, log.tokens);
  }
  return merged;
}
