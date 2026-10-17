import { type RunPart, type RunRecord, type RunSummary, type TestRecord, type TokenInfo, type TxRecord } from "./schema.ts";
/** Set to `1` to record every run (see docs/guides/explore.md). */
export declare const RECORD_ENV = "FORKIT_RECORD";
/** Directory for run records (default `.forkit` in the working directory). */
export declare const RECORD_DIR_ENV = "FORKIT_RECORD_DIR";
/** A run id every worker uses, instead of one derived from the test runner's process. */
export declare const RUN_ID_ENV = "FORKIT_RUN_ID";
type Env = Readonly<Record<string, string | undefined>>;
export declare function isRunId(id: string): boolean;
/** Whether `FORKIT_RECORD` asks for recording. */
export declare function recordingEnabled(env?: Env): boolean;
export declare function recordDir(env?: Env, cwd?: string): string;
export declare const runsDir: (dir: string) => string;
export declare const runFile: (dir: string, id: string) => string;
export declare const partsDir: (dir: string, id: string) => string;
/**
 * A name for one recorder: its pid, its thread id in a worker thread, and a random suffix, since
 * a runner that isolates test files (vitest) loads forkit, and so a recorder, once per file.
 */
export declare function workerName(): string;
/**
 * The pid of the test runner's main process, which every worker of one run shares: this process
 * in a worker thread or a single-process runner (bun test, jest --runInBand), the parent in a
 * child-process worker (vitest forks, jest workers, node --test files).
 */
export declare function runnerPid(env?: Env): number;
export declare function newRunId(now?: number, pid?: number): string;
/**
 * The run this worker records into. `FORKIT_RUN_ID` wins. Otherwise the first worker of a test
 * runner process creates `parts/.roots/<runner pid>` naming a fresh run, and the others read it.
 */
export declare function resolveRunId(dir: string, env?: Env, now?: number): string;
/** Keep a runner's pointer fresh while its run is active (see `POINTER_STALE_MS`). */
export declare function touchRunPointer(dir: string, env?: Env): void;
export type PartMeta = Pick<RunPart, "version" | "runId" | "worker" | "pid" | "argv" | "cwd" | "startedAt" | "updatedAt">;
/** One line of a part file. */
export type PartLine = {
    kind: "meta";
    meta: PartMeta;
} | {
    kind: "fork";
    record: RunPart["forks"][number];
} | {
    kind: "test";
    record: TestRecord;
} | {
    kind: "tx";
    record: TxRecord;
} | {
    kind: "deal";
    record: RunPart["deals"][number];
} | {
    kind: "fill";
    record: RunPart["fills"][number];
} | {
    kind: "http";
    record: RunPart["http"][number];
} | {
    kind: "gas";
    record: RunPart["gas"][number];
} | {
    kind: "cheat";
    record: RunPart["cheats"][number];
} | {
    kind: "labels";
    labels: Record<string, string>;
} | {
    kind: "token";
    key: string;
    info: TokenInfo;
};
export declare function partFile(dir: string, runId: string, worker: string): string;
/** Append lines to this worker's part. Synchronous, so a line is on disk when it returns. */
export declare function appendPart(file: string, lines: readonly PartLine[]): void;
export declare function emptyPart(meta: PartMeta): RunPart;
/** Replay part lines. Later lines for the same test or transaction replace earlier ones. */
export declare function applyLine(part: RunPart, line: PartLine): void;
/** Parse a part file. A torn last line (a worker killed mid-write) is skipped. */
export declare function parsePart(text: string): RunPart | undefined;
/** Merge workers' parts into one run record. Pure: the same parts give the same record. */
export declare function mergeParts(id: string, parts: readonly RunPart[]): RunRecord;
/**
 * Merge a run's parts into `runs/<id>.json` (under a lock; the file is replaced atomically) and
 * return the record. `undefined` when the run has no parts.
 */
export declare function mergeRun(dir: string, id: string): RunRecord | undefined;
/** A run record: merged afresh when its parts are newer than `runs/<id>.json`. */
export declare function readRun(dir: string, id: string): RunRecord | undefined;
/** Read a run record file, checking it looks like one. */
export declare function readRunFile(file: string): RunRecord;
export declare function summarize(run: RunRecord): RunSummary;
/** Every run id in `dir`: merged files and runs that only have parts so far. */
export declare function runIds(dir: string): string[];
/** Every run in `dir`, newest first. A run that cannot be read is skipped. */
export declare function listRuns(dir: string): RunSummary[];
export {};
//# sourceMappingURL=store.d.ts.map