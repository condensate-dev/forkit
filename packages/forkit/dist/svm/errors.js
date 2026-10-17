import { ForkitError } from "../errors.js";
/** surfpool is not installed, not on PATH, or older than the version forkit is tested against. */
export class SurfpoolNotFoundError extends ForkitError {
    name = "SurfpoolNotFoundError";
    constructor(binary, problem, cause) {
        super([
            `forkit: ${problem} (\`${binary}\`). forkit/svm needs surfpool, the Solana fork node.`,
            "Install the release binary from https://github.com/solana-foundation/surfpool/releases,",
            "or point FORKIT_SURFPOOL_BIN (or the `surfpoolBinary` option) at one.",
            "A surfnet suite that cannot run is a broken environment, not a skipped test.",
        ].join("\n"), cause === undefined ? undefined : { cause });
    }
}
/** surfpool exited, reported a failed startup, or did not become ready in time. */
export class SurfnetBootError extends ForkitError {
    name = "SurfnetBootError";
}
/** A surfnet JSON-RPC call failed: the transport, or a JSON-RPC error answer. */
export class SurfnetRpcError extends ForkitError {
    name = "SurfnetRpcError";
    method;
    /** The JSON-RPC error code, when surfpool answered with an error. */
    code;
    constructor(method, message, code, cause) {
        super(`forkit: ${method} failed: ${message}`, cause === undefined ? undefined : { cause });
        this.method = method;
        this.code = code;
    }
}
//# sourceMappingURL=errors.js.map