/**
 * `@condensate/forkit/4337`: an ERC-4337 bundler on a fork. `bundler(f)` starts Pimlico's alto
 * against the fork's anvil, with funded executors, so production code that sends user operations
 * runs unchanged against real forked state.
 *
 * alto (`@pimlico/alto`) is an optional peer dependency and runs as a separate process.
 */
import { type Address, type Chain, type Hex } from "viem";
import { type BundlerClient } from "viem/account-abstraction";
import type { Fork } from "../types.ts";
import { type AltoFlagValue, AltoNotFoundError, BundlerBootError, renderAltoFlags } from "./alto.ts";
export { containsSend, highestBlockIn, SEND_METHODS } from "./proxy.ts";
export { type AltoFlagValue, AltoNotFoundError, BundlerBootError, renderAltoFlags };
/** The canonical EntryPoint of each ERC-4337 version (the addresses viem ships). */
export declare const ENTRY_POINTS: {
    readonly "0.6": "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
    readonly "0.7": "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
    readonly "0.8": "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
    readonly "0.9": "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
};
export type EntryPointVersion = keyof typeof ENTRY_POINTS;
/** alto's `--chain-type` values forkit picks from; any other alto value can be passed as well. */
export type AltoChainType = "default" | "op-stack" | "arbitrum" | (string & {});
/** The fixed executor key forkit uses unless given others. Public, so only ever use it on a fork. */
export declare const DEFAULT_EXECUTOR_KEY: Hex;
/**
 * The fixed key of alto's utility account, which deploys alto's simulations contract at startup
 * and tops up executors. Public, so only ever use it on a fork.
 */
export declare const DEFAULT_UTILITY_KEY: Hex;
/** What each executor, and the utility account, is funded with on the fork before alto starts. */
export declare const EXECUTOR_FUNDING: bigint;
export declare const DEFAULT_BUNDLER_BOOT_TIMEOUT_MS = 60000;
export declare const DEFAULT_BUNDLER_STOP_TIMEOUT_MS = 10000;
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
export declare function resolveEntryPoints(entryPoints: BundlerOptions["entryPoints"]): {
    addresses: Address[];
    explicit: boolean;
};
/** The `--chain-type` forkit passes for `chain`. */
export declare function altoChainType(chain: Chain): AltoChainType;
/**
 * Whether alto is done with a user operation, given its `pimlico_getUserOperationStatus` status.
 *
 * alto sends the bundle transaction before it marks the operation `submitted`, and anvil mines
 * it on send, so the receipt is on chain while the operation is still `not_submitted` and still
 * in alto's processing set. alto takes an operation out of that set before it marks it
 * `included`, `reverted` or `failed`. Only those, `rejected` and `not_found` mean it is done: an
 * operation left in the set across a revert blocks the same sender with "AA10 ... Another
 * deployment operation for this sender is already being processed", and
 * `debug_bundler_clearState` does not clear the set.
 */
export declare function altoIsDone(status: unknown): boolean;
/**
 * Start an ERC-4337 bundler (alto) on the selected chain of `f`; for another chain of a
 * multi-chain fork, pass `f.on(chain)`.
 *
 * Start it before taking snapshots (in `beforeAll`, not inside a test): alto deploys helper
 * contracts and forkit funds its executors when it starts, and reverting to an earlier snapshot
 * would undo both. Per-test snapshot/revert after that is fine; see "Reverts" in docs/guides/erc-4337.md for
 * what forkit does so that alto keeps bundling across them.
 */
export declare function bundler<TChain extends Chain>(handle: Fork<TChain>, options?: BundlerOptions): Promise<Bundler>;
//# sourceMappingURL=index.d.ts.map