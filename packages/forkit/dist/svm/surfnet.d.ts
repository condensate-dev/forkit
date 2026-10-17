import { type Rpc, type RpcSubscriptions, type SolanaRpcApi, type SolanaRpcSubscriptionsApi } from "@solana/kit";
import { type SurfnetCheats } from "./cheats.ts";
/** Solana's public mainnet-beta RPC: the fork source when nothing else is configured. */
export declare const DEFAULT_SVM_RPC_URL = "https://api.mainnet-beta.solana.com";
export declare const DEFAULT_SURFNET_BOOT_TIMEOUT_MS = 60000;
export declare const DEFAULT_SURFNET_STOP_TIMEOUT_MS = 10000;
export interface SurfnetOptions {
    /**
     * The RPC to fork from. Accounts are fetched from it on demand, the first time the surfnet
     * reads them, at that RPC's current state. Default: `FORKIT_SVM_RPC_URL`, else Solana's public
     * mainnet-beta RPC (rate limited; use your own for anything but a quick try).
     */
    rpcUrl?: string;
    /** Run with no fork source at all (`surfpool start --offline`). `rpcUrl` must be unset. */
    offline?: boolean;
    /** The surfpool binary. Default: `FORKIT_SURFPOOL_BIN`, else `surfpool` on PATH. */
    surfpoolBinary?: string;
    /** Slot time in milliseconds (`--slot-time`). surfpool's default is 400. */
    slotTimeMs?: number;
    /** Extra `surfpool start` flags, appended after forkit's own. */
    args?: readonly string[];
    /** Ceiling for boot until ready. Default 60 s. */
    bootTimeoutMs?: number;
    /** Ceiling for a graceful stop before the process is killed. Default 10 s. */
    stopTimeoutMs?: number;
}
/** What `surfnet_getSurfnetInfo` reports about startup, as surfpool 1.6 serializes it. */
export interface SurfnetStartupStatus {
    phase: "planning" | "cloningRemoteAccounts" | "executingRunbooks" | "ready" | "failed" | string;
    planSealed: boolean;
    tasks: readonly {
        task: string;
        state: string;
        error: string | null;
    }[];
    error: string | null;
}
export interface SurfnetInfo {
    runbookExecutions: readonly unknown[];
    startup: SurfnetStartupStatus;
}
/** A running surfnet's endpoints, clients and lifecycle; {@link Surfnet} adds the cheatcodes. */
export interface SurfnetBase {
    /** HTTP JSON-RPC endpoint, `http://127.0.0.1:<port>`. */
    readonly rpcUrl: string;
    /** WebSocket endpoint for subscriptions. */
    readonly wsUrl: string;
    /** Where accounts are forked from, with secrets masked; `"offline"` when there is none. */
    readonly source: string;
    /** The surfpool version that is running. */
    readonly surfpoolVersion: string;
    /** A `@solana/kit` RPC client for the standard Solana methods. */
    readonly rpc: Rpc<SolanaRpcApi>;
    /** A `@solana/kit` subscriptions client over {@link Surfnet.wsUrl}. */
    readonly rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
    /** A raw JSON-RPC call, for surfpool's own `surfnet_*` methods. */
    request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
    /** `surfnet_getSurfnetInfo`: startup phase and runbook executions. */
    info(): Promise<SurfnetInfo>;
    /** Stop surfpool. Idempotent; kills it if it does not exit within `stopTimeoutMs`. */
    stop(): Promise<void>;
}
/** A running surfnet, with its cheatcodes ({@link SurfnetCheats}). */
export interface Surfnet extends SurfnetBase, SurfnetCheats {
}
/** The fork source: `"offline"`, the option, `FORKIT_SVM_RPC_URL`, or the public mainnet RPC. */
export declare function resolveSurfnetSource(options: Pick<SurfnetOptions, "rpcUrl" | "offline">, env?: Readonly<Record<string, string | undefined>>): string | undefined;
interface Ports {
    rpc: number;
    ws: number;
    studio: number;
}
/**
 * The `surfpool start` arguments. Exported for tests. Headless (no TUI), no Studio, no project
 * deploys (forkit never reads the user's txtx.yml or Anchor.toml), every listener on a port the
 * OS handed out. The fork URL is not here: it goes in through the environment, so an RPC key
 * never shows in `ps`.
 */
export declare function surfpoolArgs(options: SurfnetOptions, ports: Ports, logDir: string, offline: boolean): string[];
/**
 * Boot a surfnet: `surfpool start`, headless, forked from `rpcUrl` (see
 * {@link SurfnetOptions.rpcUrl}) or offline. Resolves once surfpool's startup reports ready.
 *
 * ```ts
 * const s = await surfnet({ rpcUrl: process.env.SOLANA_RPC_URL });
 * const { value } = await s.rpc.getBalance(address("…")).send();
 * await s.stop();
 * ```
 */
export declare function surfnet(options?: SurfnetOptions): Promise<Surfnet>;
export {};
//# sourceMappingURL=surfnet.d.ts.map