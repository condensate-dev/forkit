import { SurfnetRpcError } from "./errors.js";
let nextId = 0;
const BIGINT = "__forkit_bigint__";
/**
 * JSON with bigints as plain JSON numbers: surfpool reads lamports, token amounts, slots and
 * timestamps as u64, and a JS number loses precision above 2^53.
 */
export function stringifyWithBigints(value) {
    return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? `${BIGINT}${v.toString()}` : v).replace(new RegExp(`"${BIGINT}(-?\\d+)"`, "g"), "$1");
}
/**
 * One JSON-RPC call over HTTP. forkit/svm uses it for surfpool's own `surfnet_*` methods, which
 * `@solana/kit`'s typed RPC does not know; everything else goes through the handle's `rpc`.
 */
export async function jsonRpc(url, method, params = [], signal) {
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: stringifyWithBigints({ jsonrpc: "2.0", id: ++nextId, method, params }),
            ...(signal === undefined ? {} : { signal }),
        });
    }
    catch (error) {
        throw new SurfnetRpcError(method, error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        throw new SurfnetRpcError(method, `HTTP ${response.status}, not JSON: ${text.slice(0, 200)}`);
    }
    if (body.error !== undefined) {
        throw new SurfnetRpcError(method, body.error.message ?? "unknown error", body.error.code);
    }
    return body.result;
}
//# sourceMappingURL=rpc.js.map