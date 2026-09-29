import { createServer, type IncomingMessage, type Server } from "node:http";

/** Bundler RPC methods that submit a user operation. */
export const SEND_METHODS: ReadonlySet<string> = new Set([
  "eth_sendUserOperation",
  "pimlico_sendUserOperationNow",
]);

export interface JsonRpcRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcReply {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

/** The requests in a JSON-RPC payload: one request or a batch. */
export function requestsIn(payload: unknown): JsonRpcRequest[] {
  const list = Array.isArray(payload) ? payload : [payload];
  return list.filter((r): r is JsonRpcRequest => typeof r === "object" && r !== null);
}

/** The replies in a JSON-RPC reply body: one reply or a batch. */
export function repliesIn(reply: unknown): JsonRpcReply[] {
  const list = Array.isArray(reply) ? reply : [reply];
  return list.filter((r): r is JsonRpcReply => typeof r === "object" && r !== null);
}

/** True if the JSON-RPC payload (one request or a batch) submits a user operation. */
export function containsSend(payload: unknown): boolean {
  return requestsIn(payload).some(
    (r) => typeof r.method === "string" && SEND_METHODS.has(r.method),
  );
}

/** JSON-RPC error replies for every request in `payload`, shaped like the payload. */
export function errorReply(payload: unknown, message: string): unknown {
  const reply = (r: JsonRpcRequest) => ({
    jsonrpc: "2.0",
    id: r.id ?? null,
    error: { code: -32000, message },
  });
  return Array.isArray(payload) ? requestsIn(payload).map(reply) : reply(payload as JsonRpcRequest);
}

/** A local JSON-RPC forwarder. */
export interface RpcProxy {
  readonly url: string;
  close(): Promise<void>;
}

export interface RpcProxyOptions {
  upstream: string;
  port: number;
  /**
   * Runs before a request is forwarded. Throwing answers every request in it with a JSON-RPC
   * error carrying the message, and nothing is forwarded.
   */
  before?: (payload: unknown) => Promise<void>;
  /** Runs once the upstream answered, before the reply goes back (it may delay the reply). */
  after?: (payload: unknown, reply: unknown) => Promise<void>;
  /** Requests for which this is true run one at a time, `before` through the upstream's answer. */
  serialize?: (payload: unknown) => boolean;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Start a forwarder. Bodies go upstream unchanged and replies come back unchanged; the hooks only
 * observe, delay or refuse.
 */
export async function startRpcProxy(options: RpcProxyOptions): Promise<RpcProxy> {
  let queue: Promise<unknown> = Promise.resolve();

  const answer = async (body: string): Promise<{ status: number; text: string }> => {
    const payload = parse(body);
    if (payload !== undefined && options.before !== undefined) {
      try {
        await options.before(payload);
      } catch (error) {
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
      if (reply !== undefined) await options.after(payload, reply);
    }
    return { status: upstream.status, text };
  };

  const server: Server = createServer((req, res) => {
    (async () => {
      const body = await readBody(req);
      let result: { status: number; text: string };
      if (options.serialize?.(parse(body)) === true) {
        const turn = queue.then(() => answer(body));
        queue = turn.catch(() => {});
        result = await turn;
      } else {
        result = await answer(body);
      }
      res.writeHead(result.status, { "content-type": "application/json" }).end(result.text);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: `forkit: ${options.upstream} did not answer: ${String(error)}`,
          },
        }),
      );
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(options.port, "127.0.0.1", () => ok());
  });

  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${options.port}`,
    close() {
      closed ??= new Promise<void>((resolve) => {
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
export function highestBlockIn(payload: unknown, reply: unknown): bigint | undefined {
  const methods = new Map<unknown, unknown>();
  for (const r of requestsIn(payload)) methods.set(r.id, r.method);
  let highest: bigint | undefined;
  for (const r of repliesIn(reply)) {
    const method = methods.get(r.id);
    let hex: unknown;
    if (method === "eth_blockNumber") hex = r.result;
    else if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") {
      hex = (r.result as { number?: unknown } | null | undefined)?.number;
    }
    if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) continue;
    const n = BigInt(hex);
    if (highest === undefined || n > highest) highest = n;
  }
  return highest;
}
