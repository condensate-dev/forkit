/**
 * Where run records live and how workers' parts become one run.
 *
 * ```
 * .forkit/
 *   runs/<id>.json            the merged run record (what `forkit explore` shows)
 *   parts/<id>/<worker>.jsonl one append-only file per worker process or thread
 *   parts/.roots/<pid>        which run a test runner's workers are writing (see resolveRunId)
 * ```
 *
 * Each worker appends JSON lines to its own part, so workers never write the same file, and a
 * worker killed mid-run leaves every line it finished. Merging reads every part of a run under a
 * lock and writes `runs/<id>.json` atomically (write, then rename). The parts stay: they are the
 * source of truth, and a later merge (another worker exiting, or `forkit explore`) redoes it.
 */
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isMainThread, threadId } from "node:worker_threads";
import { stringify } from "./json.ts";
import {
  type BlockRecord,
  RUN_RECORD_VERSION,
  type RunPart,
  type RunRecord,
  type RunSummary,
  type TestRecord,
  type TokenInfo,
  type TxRecord,
} from "./schema.ts";

/** Set to `1` to record every run (see docs/guides/explore.md). */
export const RECORD_ENV = "FORKIT_RECORD";
/** Directory for run records (default `.forkit` in the working directory). */
export const RECORD_DIR_ENV = "FORKIT_RECORD_DIR";
/** A run id every worker uses, instead of one derived from the test runner's process. */
export const RUN_ID_ENV = "FORKIT_RUN_ID";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A runner's pointer older than this belongs to an earlier run whose pid was reused. */
const POINTER_STALE_MS = 6 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

type Env = Readonly<Record<string, string | undefined>>;

export function isRunId(id: string): boolean {
  return RUN_ID.test(id) && !id.includes("..");
}

/** Whether `FORKIT_RECORD` asks for recording. */
export function recordingEnabled(env: Env = process.env): boolean {
  const value = env[RECORD_ENV]?.trim().toLowerCase();
  return value !== undefined && value !== "" && !["0", "false", "off", "no"].includes(value);
}

export function recordDir(env: Env = process.env, cwd: string = process.cwd()): string {
  const dir = env[RECORD_DIR_ENV];
  return dir === undefined || dir === "" ? join(cwd, ".forkit") : dir;
}

export const runsDir = (dir: string) => join(dir, "runs");
export const runFile = (dir: string, id: string) => join(runsDir(dir), `${id}.json`);
export const partsDir = (dir: string, id: string) => join(dir, "parts", id);
const rootsDir = (dir: string) => join(dir, "parts", ".roots");

/**
 * A name for one recorder: its pid, its thread id in a worker thread, and a random suffix, since
 * a runner that isolates test files (vitest) loads forkit, and so a recorder, once per file.
 */
export function workerName(): string {
  const suffix = randomBytes(3).toString("hex");
  return isMainThread ? `${process.pid}-${suffix}` : `${process.pid}-t${threadId}-${suffix}`;
}

/**
 * The pid of the test runner's main process, which every worker of one run shares: this process
 * in a worker thread or a single-process runner (bun test, jest --runInBand), the parent in a
 * child-process worker (vitest forks, jest workers, node --test files).
 */
export function runnerPid(env: Env = process.env): number {
  if (!isMainThread) return process.pid;
  const child = process.send !== undefined || env.NODE_TEST_CONTEXT?.startsWith("child") === true;
  return child ? process.ppid : process.pid;
}

/** `20260928T231455Z` */
function stamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export function newRunId(now: number = Date.now(), pid: number = process.pid): string {
  return `${stamp(now)}-${pid}`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? ((error as { code?: string }).code ?? undefined)
    : undefined;
}

/**
 * The run this worker records into. `FORKIT_RUN_ID` wins. Otherwise the first worker of a test
 * runner process creates `parts/.roots/<runner pid>` naming a fresh run, and the others read it.
 */
export function resolveRunId(
  dir: string,
  env: Env = process.env,
  now: number = Date.now(),
): string {
  const fixed = env[RUN_ID_ENV];
  if (fixed !== undefined && fixed !== "") {
    if (!isRunId(fixed)) {
      throw new Error(
        `forkit: ${RUN_ID_ENV} must be letters, digits, dots, dashes or underscores, got ${JSON.stringify(fixed)}`,
      );
    }
    return fixed;
  }
  const root = runnerPid(env);
  const candidate = newRunId(now, root);
  const pointer = join(rootsDir(dir), String(root));
  mkdirSync(rootsDir(dir), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      writeFileSync(pointer, candidate, { flag: "wx" });
      return candidate;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    try {
      if (now - statSync(pointer).mtimeMs > POINTER_STALE_MS) {
        rmSync(pointer, { force: true });
        continue;
      }
      const existing = readFileSync(pointer, "utf8").trim();
      if (isRunId(existing)) {
        touch(pointer);
        return existing;
      }
    } catch {
      // Removed or half-written by another worker: look again.
    }
    sleepSync(5);
  }
  return candidate;
}

function touch(path: string): void {
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    // Best effort.
  }
}

/** Keep a runner's pointer fresh while its run is active (see `POINTER_STALE_MS`). */
export function touchRunPointer(dir: string, env: Env = process.env): void {
  if (env[RUN_ID_ENV] === undefined) touch(join(rootsDir(dir), String(runnerPid(env))));
}

export type PartMeta = Pick<
  RunPart,
  "version" | "runId" | "worker" | "pid" | "argv" | "cwd" | "startedAt" | "updatedAt"
>;

/** One line of a part file. */
export type PartLine =
  | { kind: "meta"; meta: PartMeta }
  | { kind: "fork"; record: RunPart["forks"][number] }
  | { kind: "test"; record: TestRecord }
  | { kind: "tx"; record: TxRecord }
  | { kind: "deal"; record: RunPart["deals"][number] }
  | { kind: "fill"; record: RunPart["fills"][number] }
  | { kind: "http"; record: RunPart["http"][number] }
  | { kind: "gas"; record: RunPart["gas"][number] }
  | { kind: "cheat"; record: RunPart["cheats"][number] }
  | { kind: "labels"; labels: Record<string, string> }
  | { kind: "token"; key: string; info: TokenInfo };

export function partFile(dir: string, runId: string, worker: string): string {
  return join(partsDir(dir, runId), `${worker}.jsonl`);
}

/** Append lines to this worker's part. Synchronous, so a line is on disk when it returns. */
export function appendPart(file: string, lines: readonly PartLine[]): void {
  if (lines.length === 0) return;
  appendFileSync(file, `${lines.map((line) => stringify(line)).join("\n")}\n`);
}

export function emptyPart(meta: PartMeta): RunPart {
  return {
    ...meta,
    forks: [],
    tests: [],
    txs: [],
    deals: [],
    fills: [],
    http: [],
    gas: [],
    cheats: [],
    labels: {},
    tokens: {},
  };
}

/** Replay part lines. Later lines for the same test or transaction replace earlier ones. */
export function applyLine(part: RunPart, line: PartLine): void {
  switch (line.kind) {
    case "meta":
      Object.assign(part, line.meta);
      return;
    case "fork":
      part.forks.push(line.record);
      return;
    case "test": {
      const at = part.tests.findIndex((t) => t.key === line.record.key);
      if (at === -1) part.tests.push(line.record);
      else part.tests[at] = line.record;
      return;
    }
    case "tx": {
      const at = part.txs.findIndex((t) => t.id === line.record.id);
      if (at === -1) part.txs.push(line.record);
      else part.txs[at] = line.record;
      return;
    }
    case "deal":
      part.deals.push(line.record);
      return;
    case "fill":
      part.fills.push(line.record);
      return;
    case "http":
      part.http.push(line.record);
      return;
    case "gas":
      part.gas.push(line.record);
      return;
    case "cheat":
      part.cheats.push(line.record);
      return;
    case "labels":
      Object.assign(part.labels, line.labels);
      return;
    case "token":
      part.tokens[line.key] = { ...part.tokens[line.key], ...line.info };
      return;
  }
}

/** Parse a part file. A torn last line (a worker killed mid-write) is skipped. */
export function parsePart(text: string): RunPart | undefined {
  let part: RunPart | undefined;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let line: PartLine;
    try {
      line = JSON.parse(raw) as PartLine;
    } catch {
      continue;
    }
    if (line.kind === "meta") part ??= emptyPart(line.meta);
    if (part !== undefined) applyLine(part, line);
  }
  return part;
}

const byTs = <T extends { ts: number }>(a: T, b: T) => a.ts - b.ts;

/** Merge workers' parts into one run record. Pure: the same parts give the same record. */
export function mergeParts(id: string, parts: readonly RunPart[]): RunRecord {
  const sorted = [...parts].sort(
    (a, b) => a.startedAt - b.startedAt || (a.worker < b.worker ? -1 : 1),
  );
  const all = <K extends "forks" | "txs" | "deals" | "fills" | "http" | "gas" | "cheats">(key: K) =>
    sorted.flatMap((p) => (p[key] ?? []) as RunPart[K][number][]).sort(byTs) as RunPart[K];
  const txs = all("txs");
  const labels: Record<string, string> = {};
  const tokens: Record<string, TokenInfo> = {};
  for (const part of sorted) {
    Object.assign(labels, part.labels);
    for (const [key, info] of Object.entries(part.tokens))
      tokens[key] = { ...tokens[key], ...info };
  }
  const blocks = new Map<string, BlockRecord>();
  for (const tx of txs) {
    if (tx.blockHash === undefined || tx.blockNumber === undefined) continue;
    const key = `${tx.chainId}:${tx.blockHash}`;
    const block = blocks.get(key) ?? {
      chainId: tx.chainId,
      number: tx.blockNumber,
      hash: tx.blockHash,
      ...(tx.blockTimestamp === undefined ? {} : { timestamp: tx.blockTimestamp }),
      txs: [],
    };
    block.txs.push(tx.id);
    blocks.set(key, block);
  }
  return {
    version: RUN_RECORD_VERSION,
    id,
    cwd: sorted[0]?.cwd ?? "",
    startedAt: Math.min(...sorted.map((p) => p.startedAt)),
    updatedAt: Math.max(...sorted.map((p) => p.updatedAt)),
    workers: sorted.map((p) => ({
      worker: p.worker,
      pid: p.pid,
      argv: p.argv,
      startedAt: p.startedAt,
      updatedAt: p.updatedAt,
    })),
    forks: all("forks"),
    tests: sorted.flatMap((p) => p.tests).sort((a, b) => a.startedAt - b.startedAt),
    txs,
    blocks: [...blocks.values()],
    deals: all("deals"),
    fills: all("fills"),
    http: all("http"),
    gas: all("gas"),
    cheats: all("cheats"),
    labels,
    tokens,
  };
}

function listFiles(dir: string, suffix: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(suffix));
  } catch {
    return [];
  }
}

function mtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function withLock<T>(path: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let locked = false;
  while (!locked) {
    try {
      mkdirSync(path);
      locked = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const age = Date.now() - (mtime(path) ?? Date.now());
      if (age > LOCK_STALE_MS) rmSync(path, { recursive: true, force: true });
      else if (Date.now() > deadline)
        break; // A wedged holder: merge anyway, the write is atomic.
      else sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    if (locked) rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Merge a run's parts into `runs/<id>.json` (under a lock; the file is replaced atomically) and
 * return the record. `undefined` when the run has no parts.
 */
export function mergeRun(dir: string, id: string): RunRecord | undefined {
  if (!isRunId(id)) return undefined;
  const pdir = partsDir(dir, id);
  const files = listFiles(pdir, ".jsonl");
  if (files.length === 0) return undefined;
  mkdirSync(runsDir(dir), { recursive: true });
  return withLock(join(runsDir(dir), `${id}.lock`), () => {
    const parts = files
      .map((name) => {
        try {
          return parsePart(readFileSync(join(pdir, name), "utf8"));
        } catch {
          return undefined;
        }
      })
      .filter((p): p is RunPart => p !== undefined);
    if (parts.length === 0) return undefined;
    const record = mergeParts(id, parts);
    const target = runFile(dir, id);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, stringify(record));
    renameSync(tmp, target);
    return record;
  });
}

/** Whether a run's parts changed after its merged file was written. */
function needsMerge(dir: string, id: string): boolean {
  const pdir = partsDir(dir, id);
  const newest = Math.max(
    0,
    ...listFiles(pdir, ".jsonl").map((name) => mtime(join(pdir, name)) ?? 0),
  );
  if (newest === 0) return false;
  return newest >= (mtime(runFile(dir, id)) ?? 0);
}

/** A run record: merged afresh when its parts are newer than `runs/<id>.json`. */
export function readRun(dir: string, id: string): RunRecord | undefined {
  if (!isRunId(id)) return undefined;
  if (needsMerge(dir, id)) {
    const merged = mergeRun(dir, id);
    if (merged !== undefined) return merged;
  }
  const file = runFile(dir, id);
  if (!existsSync(file)) return undefined;
  return readRunFile(file);
}

/** Read a run record file, checking it looks like one. */
export function readRunFile(file: string): RunRecord {
  const record = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  if (typeof record !== "object" || record === null || !Array.isArray(record.txs)) {
    throw new Error(`forkit: ${file} is not a forkit run record.`);
  }
  if (record.version !== RUN_RECORD_VERSION) {
    throw new Error(
      `forkit: ${file} is a version ${String(record.version)} run record; this forkit reads version ${RUN_RECORD_VERSION}.`,
    );
  }
  return record;
}

export function summarize(run: RunRecord): RunSummary {
  const chains = new Map<number, string>();
  for (const f of run.forks) chains.set(f.chainId, f.chainName);
  return {
    id: run.id,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    cwd: run.cwd,
    tests: run.tests.length,
    passed: run.tests.filter((t) => t.status === "pass").length,
    failed: run.tests.filter((t) => t.status === "fail").length,
    txs: run.txs.length,
    fills: run.fills.length,
    chains: [...chains].map(([chainId, chainName]) => ({ chainId, chainName })),
  };
}

/** Every run id in `dir`: merged files and runs that only have parts so far. */
export function runIds(dir: string): string[] {
  const ids = new Set(
    listFiles(runsDir(dir), ".json").map((name) => name.slice(0, -".json".length)),
  );
  try {
    for (const name of readdirSync(join(dir, "parts"))) if (!name.startsWith(".")) ids.add(name);
  } catch {
    // No parts directory.
  }
  return [...ids].filter(isRunId);
}

/** Every run in `dir`, newest first. A run that cannot be read is skipped. */
export function listRuns(dir: string): RunSummary[] {
  const out: RunSummary[] = [];
  for (const id of runIds(dir)) {
    try {
      const run = readRun(dir, id);
      if (run !== undefined) out.push(summarize(run));
    } catch {
      // A corrupt or foreign file: not a run.
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}
