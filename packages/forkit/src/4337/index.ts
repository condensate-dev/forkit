/**
 * `@condensate/forkit/4337`: an ERC-4337 bundler on a fork. `bundler(f)` starts Pimlico's alto
 * against the fork's anvil, with funded executors, so production code that sends user operations
 * runs unchanged against real forked state.
 *
 * alto (`@pimlico/alto`) is an optional peer dependency and runs as a separate process.
 */
import {
  type Address,
  type Chain,
  getAddress,
  type Hex,
  http,
  isAddress,
  keccak256,
  parseEther,
  stringToHex,
} from "viem";
import {
  type BundlerClient,
  createBundlerClient,
  entryPoint06Address,
  entryPoint07Address,
  entryPoint08Address,
  entryPoint09Address,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { freePort, isOpStack } from "../anvil.ts";
import { ForkitError } from "../errors.ts";
import type { Fork } from "../types.ts";
import {
  type AltoFlagValue,
  AltoNotFoundError,
  BundlerBootError,
  renderAltoFlags,
  resolveAlto,
  spawnAlto,
} from "./alto.ts";
import { containsSend, highestBlockIn, repliesIn, requestsIn, startRpcProxy } from "./proxy.ts";

export { containsSend, highestBlockIn, SEND_METHODS } from "./proxy.ts";
export { type AltoFlagValue, AltoNotFoundError, BundlerBootError, renderAltoFlags };

/** The canonical EntryPoint of each ERC-4337 version (the addresses viem ships). */
export const ENTRY_POINTS = {
  "0.6": entryPoint06Address,
  "0.7": entryPoint07Address,
  "0.8": entryPoint08Address,
  "0.9": entryPoint09Address,
} as const satisfies Record<string, Address>;

export type EntryPointVersion = keyof typeof ENTRY_POINTS;

/** alto's `--chain-type` values forkit picks from; any other alto value can be passed as well. */
export type AltoChainType = "default" | "op-stack" | "arbitrum" | (string & {});

/** Arbitrum One, Arbitrum Nova, Arbitrum Sepolia. */
const ARBITRUM_CHAIN_IDS: ReadonlySet<number> = new Set([42161, 42170, 421614]);

/** The fixed executor key forkit uses unless given others. Public, so only ever use it on a fork. */
export const DEFAULT_EXECUTOR_KEY: Hex = keccak256(stringToHex("forkit/4337/executor/0"));

/**
 * The fixed key of alto's utility account, which deploys alto's simulations contract at startup
 * and tops up executors. Public, so only ever use it on a fork.
 */
export const DEFAULT_UTILITY_KEY: Hex = keccak256(stringToHex("forkit/4337/utility"));

/** What each executor, and the utility account, is funded with on the fork before alto starts. */
export const EXECUTOR_FUNDING = parseEther("1000");

export const DEFAULT_BUNDLER_BOOT_TIMEOUT_MS = 60_000;
export const DEFAULT_BUNDLER_STOP_TIMEOUT_MS = 10_000;

export interface BundlerOptions {
  /**
   * EntryPoints to serve, as versions (`"0.7"`) or addresses. Default: every canonical EntryPoint
   * (v0.6 to v0.9) that has code on the fork. A listed EntryPoint with no code fails loudly.
   */
  entryPoints?: readonly (EntryPointVersion | Address)[];
  /**
   * alto's safe mode: enforce the ERC-7562 validation rules. Default `false`, as Pimlico recommends
   * for a local bundler; turn it on to test that your account or paymaster passes them.
   */
  safeMode?: boolean;
  /**
   * alto's `--chain-type`. Default: `op-stack` for OP-stack chains (detected like anvil's
   * `--optimism`), `arbitrum` for Arbitrum One, Nova and Sepolia, else `default`.
   */
  chainType?: AltoChainType;
  /**
   * Private keys for alto's executors, the accounts that submit bundles. Each is funded with
   * {@link EXECUTOR_FUNDING} on the fork. Default: one fixed key ({@link DEFAULT_EXECUTOR_KEY}), so
   * the fork cache sees the same accounts on every run and replays offline.
   */
  executorKeys?: readonly Hex[];
  /**
   * Private key of alto's utility account, which deploys alto's simulations contract when it starts
   * and tops up the executors. Funded like them. Default: {@link DEFAULT_UTILITY_KEY}.
   */
  utilityKey?: Hex;
  /**
   * Extra alto flags by their `alto --help` name, without dashes, e.g. `{ "max-bundle-interval":
   * 200 }`. They override forkit's own, so use them with care.
   */
  altoFlags?: Readonly<Record<string, AltoFlagValue | undefined>>;
  /**
   * alto's CLI (`…/@pimlico/alto/esm/cli/alto.js`, run with Node) or an alto executable.
   * Default: `@pimlico/alto`, resolved from forkit, then from the working directory.
   */
  altoBinary?: string;
  /** Ceiling for alto to start and answer, in milliseconds. Default 60 000. */
  bootTimeoutMs?: number;
  /** Ceiling for alto to stop before it is killed, in milliseconds. Default 10 000. */
  stopTimeoutMs?: number;
  /**
   * Every line alto prints. Default: dropped, except that the last lines are kept for error
   * messages; `FORKIT_DEBUG=1` prints them and raises alto's log level to `info`.
   */
  onLog?: (line: string) => void;
}

/** A running bundler on a fork. */
export interface Bundler {
  /** The bundler's JSON-RPC URL: point production code (or any bundler client) here. */
  readonly url: string;
  /** The EntryPoints it serves, checksummed. */
  readonly entryPoints: readonly Address[];
  /** The executor accounts that submit bundles. */
  readonly executors: readonly Address[];
  /** The forked chain it bundles for. */
  readonly chain: Chain;
  /**
   * A viem bundler client on {@link Bundler.url}, with the fork's client for reads. It has no
   * account: pass `account` to `sendUserOperation` and friends, or build your own client with one.
   */
  readonly client: BundlerClient;
  /** The last lines alto printed, for debugging. */
  logs(): string;
  /** Stop alto and the proxy in front of it. Idempotent. */
  stop(): Promise<void>;
}

/** Resolve `entryPoints` to addresses, checking each is a version or an address. */
export function resolveEntryPoints(entryPoints: BundlerOptions["entryPoints"]): {
  addresses: Address[];
  explicit: boolean;
} {
  if (entryPoints === undefined) {
    return { addresses: Object.values(ENTRY_POINTS), explicit: false };
  }
  if (entryPoints.length === 0) {
    throw new ForkitError("forkit: bundler entryPoints is empty; list at least one, or omit it.");
  }
  const addresses = entryPoints.map((entry) => {
    if (entry in ENTRY_POINTS) return ENTRY_POINTS[entry as EntryPointVersion];
    if (isAddress(entry, { strict: false })) return getAddress(entry);
    throw new ForkitError(
      `forkit: bundler entryPoints: ${JSON.stringify(entry)} is neither an EntryPoint version (${Object.keys(ENTRY_POINTS).join(", ")}) nor an address.`,
    );
  });
  return { addresses: [...new Set(addresses)], explicit: true };
}

/** The `--chain-type` forkit passes for `chain`. */
export function altoChainType(chain: Chain): AltoChainType {
  if (isOpStack(chain)) return "op-stack";
  if (ARBITRUM_CHAIN_IDS.has(chain.id)) return "arbitrum";
  return "default";
}

function versionOf(address: Address): string {
  const entry = Object.entries(ENTRY_POINTS).find(([, a]) => a === address);
  return entry === undefined ? address : `v${entry[0]} (${address})`;
}

async function blockLabel(f: Fork): Promise<string> {
  const block = await f.client.getBlockNumber({ cacheTime: 0 }).catch(() => undefined);
  return `${f.chain.name} (${f.chain.id})${block === undefined ? "" : ` at block ${block}`}`;
}

async function waitUntilReady(
  url: string,
  exited: Promise<string>,
  timeoutMs: number,
): Promise<{ ok: true; entryPoints: Address[] } | { ok: false; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  let exit: string | undefined;
  void exited.then((reason) => {
    exit = reason;
  });
  while (Date.now() < deadline) {
    if (exit !== undefined) return { ok: false, reason: `alto exited (${exit})` };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_supportedEntryPoints" }),
        signal: AbortSignal.timeout(2_000),
      });
      const body = (await response.json()) as { result?: Address[] };
      if (Array.isArray(body.result)) return { ok: true, entryPoints: body.result };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { ok: false, reason: `alto did not answer within ${timeoutMs}ms` };
}

/** A bundler-RPC call straight to alto. */
async function callAlto(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error !== undefined) {
    throw new ForkitError(
      `forkit: alto refused ${method}: ${body.error.message ?? JSON.stringify(body.error)}`,
    );
  }
  return body.result;
}

/** How long a successful receipt reply waits for alto to finish with the bundle. */
const INCLUDED_WAIT_MS = 10_000;

/**
 * Start an ERC-4337 bundler (alto) on the selected chain of `f`; for another chain of a
 * multi-chain fork, pass `f.on(chain)`.
 *
 * Start it before taking snapshots (in `beforeAll`, not inside a test): alto deploys helper
 * contracts and forkit funds its executors when it starts, and reverting to an earlier snapshot
 * would undo both. Per-test snapshot/revert after that is fine; see "Reverts" in docs/4337.md for
 * what forkit does so that alto keeps bundling across them.
 */
export async function bundler<TChain extends Chain>(
  handle: Fork<TChain>,
  options: BundlerOptions = {},
): Promise<Bundler> {
  // The bundler only needs chain-agnostic calls; the chain-typed client is invariant in TChain.
  const f = handle as unknown as Fork;
  const debug = process.env.FORKIT_DEBUG === "1" || process.env.FORKIT_DEBUG === "true";
  const alto = resolveAlto(options.altoBinary);
  const chain = f.chain;

  // EntryPoints: every one asked for must have code; by default, serve whichever are deployed.
  const { addresses, explicit } = resolveEntryPoints(options.entryPoints);
  const deployed = await Promise.all(
    addresses.map(async (address) => {
      const code = await f.client.getCode({ address });
      return code !== undefined && code !== "0x";
    }),
  );
  const missing = addresses.filter((_, i) => !deployed[i]);
  const entryPoints = addresses.filter((_, i) => deployed[i]);
  if (explicit && missing.length > 0) {
    throw new BundlerBootError(
      `forkit: no EntryPoint code at ${missing.map(versionOf).join(", ")} on ${await blockLabel(f)}. Deploy it on the fork first (e.g. anvil_setCode), or pick a block where it exists.`,
    );
  }
  if (entryPoints.length === 0) {
    const versions = Object.keys(ENTRY_POINTS).map((v) => `v${v}`);
    throw new BundlerBootError(
      `forkit: none of the canonical EntryPoints (${versions.join(", ")}) has code on ${await blockLabel(f)}. Deploy one on the fork and pass its address in entryPoints.`,
    );
  }

  const executorKeys = options.executorKeys ?? [DEFAULT_EXECUTOR_KEY];
  if (executorKeys.length === 0) {
    throw new ForkitError(
      "forkit: bundler executorKeys is empty; omit it to use forkit's default.",
    );
  }
  const executors = executorKeys.map((key) => privateKeyToAccount(key).address);
  const utilityKey = options.utilityKey ?? DEFAULT_UTILITY_KEY;
  for (const account of [...executors, privateKeyToAccount(utilityKey).address]) {
    await f.dealNative(account, EXECUTOR_FUNDING);
  }

  // alto reads the chain through forkit, which records the highest block alto has been told of.
  let altoHighest = 0n;
  const chainProxy = await startRpcProxy({
    upstream: f.rpcUrl,
    port: await freePort(),
    async after(payload, reply) {
      const highest = highestBlockIn(payload, reply);
      if (highest !== undefined && highest > altoHighest) altoHighest = highest;
    },
  });

  const altoPort = await freePort();
  const flags = renderAltoFlags({
    entrypoints: entryPoints,
    "rpc-url": chainProxy.url,
    "executor-private-keys": executorKeys,
    "utility-private-key": utilityKey,
    "safe-mode": options.safeMode ?? false,
    "chain-type": options.chainType ?? altoChainType(chain),
    port: altoPort,
    "enable-debug-endpoints": true,
    "log-level": debug ? "info" : "warn",
    ...options.altoFlags,
  });
  const onLine =
    options.onLog ?? (debug ? (line: string) => console.error(`[alto] ${line}`) : () => {});
  const processHandle = spawnAlto(alto, flags, onLine);
  const altoUrl = `http://127.0.0.1:${altoPort}`;
  const bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BUNDLER_BOOT_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_BUNDLER_STOP_TIMEOUT_MS;

  const fail = async (error: Error): Promise<never> => {
    await Promise.all([processHandle.stop(stopTimeoutMs), chainProxy.close()]);
    throw error;
  };
  const withOutput = (message: string) => {
    const output = processHandle.output();
    return new BundlerBootError(
      `${message}\n${output === "" ? "(alto printed nothing)" : `alto's last output:\n${output}`}`,
    );
  };

  const ready = await waitUntilReady(altoUrl, processHandle.exited, bootTimeoutMs);
  if (!ready.ok) {
    if (/spawn error: .*ENOENT/.test(ready.reason)) {
      return await fail(
        new AltoNotFoundError(
          `could not run ${alto.command}${alto.command === "node" ? " (alto runs on Node.js; is node on PATH?)" : ""}.`,
        ),
      );
    }
    return await fail(
      withOutput(`forkit: the bundler did not start for ${await blockLabel(f)}: ${ready.reason}.`),
    );
  }
  const served = new Set(ready.entryPoints.map((a) => a.toLowerCase()));
  const unserved = entryPoints.filter((a) => !served.has(a.toLowerCase()));
  if (unserved.length > 0) {
    return await fail(
      withOutput(
        `forkit: alto started but does not serve ${unserved.map(versionOf).join(", ")} (it serves ${ready.entryPoints.join(", ") || "none"}).`,
      ),
    );
  }

  const where = `${chain.name} (${chain.id})`;
  // The block mined for the last send. If it is gone or changed, the fork was reverted since.
  let lastMined: { number: bigint; hash: Hex } | undefined;

  /** After a revert, alto still tracks operations the chain no longer has: forget them. */
  const clearIfReverted = async () => {
    const mark = lastMined;
    if (mark === undefined) return;
    const block = await f.client.getBlock({ blockNumber: mark.number }).catch(() => undefined);
    if (block?.hash === mark.hash) return;
    lastMined = undefined;
    await callAlto(altoUrl, "debug_bundler_clearState", []);
  };

  /**
   * alto only looks at blocks above the highest it has seen. After a revert the chain is lower
   * than that, and a bundle mined there would never count as included (its executor would stay
   * busy for good). So mine past it first: normally one block, after a revert more.
   */
  const prepareSend = async () => {
    for (const executor of executors) {
      const balance = await f.client.getBalance({ address: executor });
      if (balance < parseEther("1")) {
        throw new ForkitError(
          `forkit: the bundler's executor ${executor} has ${balance} wei on ${where}, not the ${EXECUTOR_FUNDING} forkit funded it with. The fork was most likely reverted to a snapshot taken before bundler() started, which also undoes what alto deployed when it started. Start the bundler before any snapshot: in beforeAll, not inside a test.`,
        );
      }
    }
    const head = await f.client.getBlockNumber({ cacheTime: 0 });
    const target = (altoHighest > head ? altoHighest : head) + 1n;
    await f.client.mine({ blocks: Number(target - head) });
    const mined = await f.client.getBlock({ blockNumber: target });
    lastMined = { number: mined.number, hash: mined.hash };
  };

  /** Hold a receipt until alto has finished with its bundle, so a revert cannot strand it. */
  const awaitIncluded = async (userOpHash: unknown) => {
    const deadline = Date.now() + INCLUDED_WAIT_MS;
    while (Date.now() < deadline) {
      const status = (await callAlto(altoUrl, "pimlico_getUserOperationStatus", [userOpHash]).catch(
        () => undefined,
      )) as { status?: unknown } | undefined;
      if (status?.status !== "submitted") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const proxy = await startRpcProxy({
    upstream: altoUrl,
    port: await freePort(),
    serialize: containsSend,
    async before(payload) {
      await clearIfReverted();
      if (containsSend(payload)) await prepareSend();
    },
    async after(payload, reply) {
      const receipts = new Map<unknown, unknown>();
      for (const r of requestsIn(payload)) {
        if (r.method === "eth_getUserOperationReceipt" && Array.isArray(r.params)) {
          receipts.set(r.id, r.params[0]);
        }
      }
      if (receipts.size === 0) return;
      for (const r of repliesIn(reply)) {
        if (receipts.has(r.id) && r.result !== null && r.result !== undefined) {
          await awaitIncluded(receipts.get(r.id));
        }
      }
    },
  });

  let stopping: Promise<void> | undefined;
  return {
    url: proxy.url,
    entryPoints: entryPoints.map((a) => getAddress(a)),
    executors,
    chain,
    client: createBundlerClient({ client: f.client, transport: http(proxy.url) }),
    logs: () => processHandle.output(),
    stop() {
      stopping ??= Promise.all([
        proxy.close(),
        processHandle.stop(stopTimeoutMs).then(() => chainProxy.close()),
      ]).then(() => {});
      return stopping;
    },
  };
}
