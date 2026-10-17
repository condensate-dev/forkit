import { ForkitError } from "../errors.ts";
/** surfpool is not installed, not on PATH, or older than the version forkit is tested against. */
export declare class SurfpoolNotFoundError extends ForkitError {
    name: string;
    constructor(binary: string, problem: string, cause?: unknown);
}
/** surfpool exited, reported a failed startup, or did not become ready in time. */
export declare class SurfnetBootError extends ForkitError {
    name: string;
}
/** A surfnet JSON-RPC call failed: the transport, or a JSON-RPC error answer. */
export declare class SurfnetRpcError extends ForkitError {
    name: string;
    readonly method: string;
    /** The JSON-RPC error code, when surfpool answered with an error. */
    readonly code: number | undefined;
    constructor(method: string, message: string, code?: number, cause?: unknown);
}
//# sourceMappingURL=errors.d.ts.map