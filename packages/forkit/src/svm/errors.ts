import { ForkitError } from "../errors.ts";

/** surfpool is not installed, not on PATH, or older than the version forkit is tested against. */
export class SurfpoolNotFoundError extends ForkitError {
  override name = "SurfpoolNotFoundError";

  constructor(binary: string, problem: string, cause?: unknown) {
    super(
      [
        `forkit: ${problem} (\`${binary}\`). forkit/svm needs surfpool, the Solana fork node.`,
        "Install the release binary from https://github.com/solana-foundation/surfpool/releases,",
        "or point FORKIT_SURFPOOL_BIN (or the `surfpoolBinary` option) at one.",
        "A surfnet suite that cannot run is a broken environment, not a skipped test.",
      ].join("\n"),
      cause === undefined ? undefined : { cause },
    );
  }
}

/** surfpool exited, reported a failed startup, or did not become ready in time. */
export class SurfnetBootError extends ForkitError {
  override name = "SurfnetBootError";
}

/** A surfnet JSON-RPC call failed: the transport, or a JSON-RPC error answer. */
export class SurfnetRpcError extends ForkitError {
  override name = "SurfnetRpcError";
  readonly method: string;
  /** The JSON-RPC error code, when surfpool answered with an error. */
  readonly code: number | undefined;

  constructor(method: string, message: string, code?: number, cause?: unknown) {
    super(`forkit: ${method} failed: ${message}`, cause === undefined ? undefined : { cause });
    this.method = method;
    this.code = code;
  }
}
