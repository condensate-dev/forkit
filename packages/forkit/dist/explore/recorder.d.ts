import { type RawRequest } from "../client.ts";
import { type ForkitEvent } from "../events.ts";
import { type CallFrame } from "../trace.ts";
import type { BalanceChange, RunPart } from "./schema.ts";
export interface RecorderOptions {
    /** Record directory (default `FORKIT_RECORD_DIR`, else `.forkit` in the working directory). */
    dir?: string;
    /** Run id (default `FORKIT_RUN_ID`, else shared by the test runner's workers). */
    runId?: string;
    /** Write the part file (default `true`). `false` keeps the record in memory only. */
    write?: boolean;
    /** Read receipts, traces and balances from the fork (default `true`). */
    enrich?: boolean;
    /** JSON-RPC to a fork, by its URL. Tests inject a fake. */
    request?: (rpcUrl: string) => RawRequest;
}
/** Net balance changes of a transaction: native value moved in its trace, gas, ERC-20 Transfers. */
export declare function balanceChanges(trace: CallFrame | undefined, logs: readonly {
    address: string;
    topics: readonly string[];
    data: string;
}[], from: string | undefined, fee: bigint): BalanceChange[];
export declare class RunRecorder {
    #private;
    readonly part: RunPart;
    readonly dir: string;
    constructor(options?: RecorderOptions);
    get runId(): string;
    /** Subscribe to run events. Idempotent. */
    start(): this;
    stop(): void;
    /** Handle one run event. */
    handle(event: ForkitEvent): void;
    /**
     * Merge this run's parts (every worker's, not just this one's) into `runs/<id>.json`. A
     * recorder that wrote nothing still merges: in a global setup, it outlives the workers.
     */
    merge(): void;
}
/**
 * Record this process's run events into `.forkit/runs/<id>.json` (see docs/guides/explore.md).
 * Idempotent: a second call returns the recorder already running.
 */
export declare function startRecording(options?: RecorderOptions): RunRecorder;
/** Stop recording and merge what was recorded. */
export declare function stopRecording(): Promise<void>;
/** The recorder `startRecording` started, if any. */
export declare function activeRecorder(): RunRecorder | undefined;
//# sourceMappingURL=recorder.d.ts.map