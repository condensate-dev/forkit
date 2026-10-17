import { createServer } from "node:http";
/** Bundler RPC methods that submit a user operation. */
export const SEND_METHODS = new Set([
    "eth_sendUserOperation",
    "pimlico_sendUserOperationNow",
]);
/** The requests in a JSON-RPC payload: one request or a batch. */
export function requestsIn(payload) {
    const list = Array.isArray(payload) ? payload : [payload];
    return list.filter((r) => typeof r === "object" && r !== null);
}
/** The replies in a JSON-RPC reply body: one reply or a batch. */
export function repliesIn(reply) {
    const list = Array.isArray(reply) ? reply : [reply];
    return list.filter((r) => typeof r === "object" && r !== null);
}
/** True if the JSON-RPC payload (one request or a batch) submits a user operation. */
export function containsSend(payload) {
    return requestsIn(payload).some((r) => typeof r.method === "string" && SEND_METHODS.has(r.method));
}
/** JSON-RPC error replies for every request in `payload`, shaped like the payload. */
export function errorReply(payload, message) {
    const reply = (r) => ({
        jsonrpc: "2.0",
        id: r.id ?? null,
        error: { code: -32000, message },
    });
    return Array.isArray(payload) ? requestsIn(payload).map(reply) : reply(payload);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}
function parse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/**
 * Start a forwarder. Bodies go upstream unchanged and replies come back unchanged; the hooks only
 * observe, delay or refuse.
 */
export async function startRpcProxy(options) {
    let queue = Promise.resolve();
    const answer = async (body) => {
        const payload = parse(body);
        if (payload !== undefined && options.before !== undefined) {
            try {
                await options.before(payload);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { status: 200, text: JSON.stringify(errorReply(payload, message)) };
            }
        }
        const upstream = await fetch(options.upstream, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });
        const text = await upstream.text();
        if (payload !== undefined && options.after !== undefined) {
            const reply = parse(text);
            if (reply !== undefined)
                await options.after(payload, reply);
        }
        return { status: upstream.status, text };
    };
    const server = createServer((req, res) => {
        (async () => {
            const body = await readBody(req);
            let result;
            if (options.serialize?.(parse(body)) === true) {
                const turn = queue.then(() => answer(body));
                queue = turn.catch(() => { });
                result = await turn;
            }
            else {
                result = await answer(body);
            }
            res.writeHead(result.status, { "content-type": "application/json" }).end(result.text);
        })().catch((error) => {
            if (!res.headersSent)
                res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: {
                    code: -32603,
                    message: `forkit: ${options.upstream} did not answer: ${String(error)}`,
                },
            }));
        });
    });
    await new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(options.port, "127.0.0.1", () => ok());
    });
    let closed;
    return {
        url: `http://127.0.0.1:${options.port}`,
        close() {
            closed ??= new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
            return closed;
        },
    };
}
/**
 * The highest block number in replies to block queries (`eth_blockNumber`, `eth_getBlockBy*`),
 * or `undefined` if there is none. Used to learn what alto has seen of the chain.
 */
export function highestBlockIn(payload, reply) {
    const methods = new Map();
    for (const r of requestsIn(payload))
        methods.set(r.id, r.method);
    let highest;
    for (const r of repliesIn(reply)) {
        const method = methods.get(r.id);
        let hex;
        if (method === "eth_blockNumber")
            hex = r.result;
        else if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") {
            hex = r.result?.number;
        }
        if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex))
            continue;
        const n = BigInt(hex);
        if (highest === undefined || n > highest)
            highest = n;
    }
    return highest;
}
//# sourceMappingURL=proxy.js.map