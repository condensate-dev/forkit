import { SurfnetRpcError } from "./errors.ts";

let nextId = 0;

/**
 * One JSON-RPC call over HTTP. forkit/svm uses it for surfpool's own `surfnet_*` methods, which
 * `@solana/kit`'s typed RPC does not know; everything else goes through the handle's `rpc`.
 */
export async function jsonRpc<T>(
  url: string,
  method: string,
  params: readonly unknown[] = [],
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw new SurfnetRpcError(method, error instanceof Error ? error.message : String(error));
  }
  const text = await response.text();
  let body: { result?: T; error?: { code?: number; message?: string } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new SurfnetRpcError(method, `HTTP ${response.status}, not JSON: ${text.slice(0, 200)}`);
  }
  if (body.error !== undefined) {
    throw new SurfnetRpcError(method, body.error.message ?? "unknown error", body.error.code);
  }
  return body.result as T;
}
