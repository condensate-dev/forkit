/**
 * Collect run events in the process where tests run, plus what rendering needs later: labels of
 * the addresses involved, and each transferred token's symbol and decimals (read from the fork
 * while it is still up).
 */
import { decodeAbiParameters, type Hex, hexToString, isAddress, size } from "viem";
import { type ForkitEvent, onForkitEvent } from "../events.ts";
import { labelOf } from "../labels.ts";
import { type RunLog, type TokenInfo, tokenKey } from "./serialize.ts";

/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const DECIMALS = "0x313ce567";
const SYMBOL = "0x95d89b41";
const LOOKUP_TIMEOUT_MS = 5_000;

export interface RunCollector {
  /** Every event collected so far, in order. */
  readonly events: readonly ForkitEvent[];
  /** The whole run so far, once pending token lookups finish. */
  snapshot(): Promise<RunLog>;
  /** The events since the previous `drain()` (with labels and tokens), once lookups finish. */
  drain(): Promise<RunLog>;
  /** Stop collecting. */
  stop(): void;
}

/** `address` from a 32-byte topic, lowercase. */
export function topicAddress(topic: Hex | undefined): string | undefined {
  if (topic === undefined || topic.length !== 66) return undefined;
  return `0x${topic.slice(26)}`.toLowerCase();
}

function decodeSymbol(result: unknown): string | undefined {
  if (typeof result !== "string" || !result.startsWith("0x") || result === "0x") return undefined;
  const data = result as Hex;
  try {
    const [symbol] = decodeAbiParameters([{ type: "string" }], data);
    if (symbol !== "") return symbol;
  } catch {
    // Some old tokens return bytes32.
  }
  if (size(data) === 32) {
    const text = hexToString(data).replace(/\0+$/, "");
    if (text !== "" && /^[\x20-\x7e]+$/.test(text)) return text;
  }
  return undefined;
}

/** Read `decimals()` and `symbol()` of an ERC-20 over JSON-RPC. Never throws. */
export async function lookupToken(rpcUrl: string, address: string): Promise<TokenInfo> {
  const call = (id: number, data: string) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: address, data }, "latest"],
  });
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([call(1, DECIMALS), call(2, SYMBOL)]),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    const answers = (await response.json()) as { id: number; result?: unknown }[];
    if (!Array.isArray(answers)) return {};
    const result = (id: number) => answers.find((a) => a.id === id)?.result;
    const info: TokenInfo = {};
    const decimals = result(1);
    if (typeof decimals === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(decimals)) {
      const value = BigInt(decimals);
      if (value <= 77n) info.decimals = Number(value);
    }
    const symbol = decodeSymbol(result(2));
    if (symbol !== undefined) info.symbol = symbol;
    return info;
  } catch {
    return {};
  }
}

/** Every address an event mentions, lowercase. */
function addressesOf(event: ForkitEvent): string[] {
  const found: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && isAddress(value, { strict: false })) {
      found.push(value.toLowerCase());
    }
  };
  switch (event.type) {
    case "tx:sent":
    case "tx:reverted":
      add(event.from);
      add(event.to);
      break;
    case "tx:mined":
      add(event.from);
      add(event.to);
      add(event.contractAddress);
      for (const log of event.logs) {
        add(log.address);
        if (log.topics[0] === TRANSFER_TOPIC) {
          add(topicAddress(log.topics[1]));
          add(topicAddress(log.topics[2]));
        }
      }
      break;
    case "bridge:fill":
      for (const value of Object.values(event.details ?? {})) add(value);
      break;
    default:
      break;
  }
  return found;
}

/**
 * Start collecting run events in this process. Use it where tests run: in a jest or node:test
 * file (then `formatRun(await run.snapshot())` in `afterAll`), or through the vitest setup file
 * and bun preload, which do it for you.
 */
export function collectRun(): RunCollector {
  const events: ForkitEvent[] = [];
  const tokens: Record<string, TokenInfo> = {};
  const lookups = new Map<string, Promise<void>>();
  let drained = 0;

  // Forks on an offline cache cannot answer reads they never recorded: skip them, rather than
  // make the cache warn about misses the test itself never caused.
  const offline = new Set<string>();
  const watchTokens = (event: ForkitEvent) => {
    if (event.type === "fork:boot" && event.cache?.mode === "offline") offline.add(event.rpcUrl);
    if (event.type !== "tx:mined" || offline.has(event.rpcUrl)) return;
    for (const log of event.logs) {
      if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
      const key = tokenKey(event.chainId, log.address);
      if (lookups.has(key)) continue;
      lookups.set(
        key,
        lookupToken(event.rpcUrl, log.address).then((info) => {
          tokens[key] = info;
        }),
      );
    }
  };

  const off = onForkitEvent((event) => {
    events.push(event);
    watchTokens(event);
  });

  const build = async (slice: ForkitEvent[]): Promise<RunLog> => {
    await Promise.all(lookups.values());
    const labels: Record<string, string> = {};
    for (const event of slice) {
      for (const address of addressesOf(event)) {
        const name = labelOf(address);
        if (name !== undefined) labels[address] = name;
      }
    }
    return { events: slice, labels, tokens: { ...tokens } };
  };

  return {
    events,
    snapshot: () => build([...events]),
    drain: () => {
      const slice = events.slice(drained);
      drained = events.length;
      return build(slice);
    },
    stop: off,
  };
}
