import type { Chain } from "viem";
/** Environment variable that overrides the fork RPC for one chain id, e.g. `FORKIT_RPC_URL_8453`. */
export declare function rpcEnvVar(chainId: number): string;
export type RpcSource = "option" | "env" | "chain-default";
export interface ResolvedRpc {
    url: string;
    source: RpcSource;
}
/**
 * Resolve the upstream RPC for a fork: an explicit `forkUrl`, else `FORKIT_RPC_URL_<chainId>`,
 * else the viem chain's default RPC.
 */
export declare function resolveForkUrl(chain: Chain, forkUrl: string | undefined, env?: Readonly<Record<string, string | undefined>>): ResolvedRpc;
/** Strip credentials, query strings and long path segments (API keys) from a URL for messages. */
export declare function redactUrl(url: string): string;
//# sourceMappingURL=rpc.d.ts.map