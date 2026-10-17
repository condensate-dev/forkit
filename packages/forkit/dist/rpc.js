/** Environment variable that overrides the fork RPC for one chain id, e.g. `FORKIT_RPC_URL_8453`. */
export function rpcEnvVar(chainId) {
    return `FORKIT_RPC_URL_${chainId}`;
}
/**
 * Resolve the upstream RPC for a fork: an explicit `forkUrl`, else `FORKIT_RPC_URL_<chainId>`,
 * else the viem chain's default RPC.
 */
export function resolveForkUrl(chain, forkUrl, env = process.env) {
    if (forkUrl !== undefined && forkUrl !== "")
        return { url: forkUrl, source: "option" };
    const fromEnv = env[rpcEnvVar(chain.id)];
    if (fromEnv !== undefined && fromEnv !== "")
        return { url: fromEnv, source: "env" };
    const fallback = chain.rpcUrls.default.http[0];
    if (fallback === undefined) {
        throw new Error(`forkit: chain ${chain.name} (${chain.id}) has no default RPC. Pass forkUrl or set ${rpcEnvVar(chain.id)}.`);
    }
    return { url: fallback, source: "chain-default" };
}
/** Strip credentials, query strings and long path segments (API keys) from a URL for messages. */
export function redactUrl(url) {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname
            .split("/")
            .map((segment) => (segment.length >= 20 ? "<redacted>" : segment))
            .join("/");
        return `${parsed.protocol}//${parsed.host}${path}${parsed.search === "" ? "" : "?<redacted>"}`;
    }
    catch {
        return "<unparseable url>";
    }
}
//# sourceMappingURL=rpc.js.map