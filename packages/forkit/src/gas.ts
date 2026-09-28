/**
 * Gas snapshots, like `forge snapshot`: record the gas of labelled transactions in a
 * `.gas-snapshot` file, commit it, and let CI fail when a change moves gas.
 */
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ForkitAssertionError, ForkitError } from "./errors.ts";

/**
 * - `write`: record every measurement into the file (default outside CI).
 * - `check`: compare against the file and fail on a difference or a missing entry (default when
 *   `CI` is set).
 * - `off`: measure and return the gas, touch no file.
 */
export type GasSnapshotMode = "write" | "check" | "off";

export const GAS_SNAPSHOT_MODES: readonly GasSnapshotMode[] = ["write", "check", "off"];
export const GAS_SNAPSHOT_ENV = "FORKIT_GAS_SNAPSHOT";
export const GAS_SNAPSHOT_FILE_ENV = "FORKIT_GAS_SNAPSHOT_FILE";
export const DEFAULT_GAS_SNAPSHOT_FILE = ".gas-snapshot";

export interface GasSnapshotSettings {
  mode: GasSnapshotMode;
  /** Absolute path of the snapshot file. */
  file: string;
}

export function resolveGasSettings(
  mode: GasSnapshotMode | undefined,
  file: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): GasSnapshotSettings {
  if (mode !== undefined && !(GAS_SNAPSHOT_MODES as readonly string[]).includes(mode)) {
    throw new ForkitError(
      `forkit: gasSnapshot ${JSON.stringify(mode)} is not one of ${GAS_SNAPSHOT_MODES.join(", ")}`,
    );
  }
  const envMode = env[GAS_SNAPSHOT_ENV];
  if (mode === undefined && envMode !== undefined && envMode !== "") {
    if (!(GAS_SNAPSHOT_MODES as readonly string[]).includes(envMode)) {
      throw new ForkitError(
        `forkit: ${GAS_SNAPSHOT_ENV}=${envMode} is not one of ${GAS_SNAPSHOT_MODES.join(", ")}`,
      );
    }
  }
  const ci = env.CI !== undefined && env.CI !== "" && env.CI !== "false" && env.CI !== "0";
  const resolvedMode = mode ?? (envMode ? (envMode as GasSnapshotMode) : ci ? "check" : "write");
  return {
    mode: resolvedMode,
    file: resolve(file ?? env[GAS_SNAPSHOT_FILE_ENV] ?? DEFAULT_GAS_SNAPSHOT_FILE),
  };
}

const LINE = /^(.*) \(gas: (\d+)\)$/;

/** Parse `label (gas: 123)` lines. */
export function parseGasSnapshot(text: string): Map<string, bigint> {
  const entries = new Map<string, bigint>();
  for (const line of text.split("\n")) {
    const match = LINE.exec(line.trimEnd());
    if (match?.[1] !== undefined && match[2] !== undefined) entries.set(match[1], BigInt(match[2]));
  }
  return entries;
}

/** One `label (gas: 123)` line per entry, sorted by label, so the file diffs cleanly. */
export function formatGasSnapshot(entries: ReadonlyMap<string, bigint>): string {
  const labels = [...entries.keys()].sort();
  return labels.map((label) => `${label} (gas: ${entries.get(label)})\n`).join("");
}

function read(file: string): Map<string, bigint> {
  try {
    return parseGasSnapshot(readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
}

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

/** A lock directory beside the file, so parallel test workers do not lose each other's writes. */
async function withLock<T>(file: string, fn: () => T): Promise<T> {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmdirSync(lock);
      } catch {
        // Released meanwhile.
      }
      if (Date.now() > deadline) throw new ForkitError(`forkit: timed out locking ${file}`);
      await new Promise((ok) => setTimeout(ok, 10));
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

function describeDelta(before: bigint, after: bigint): string {
  const delta = after - before;
  const pct =
    before === 0n
      ? ""
      : ` (${delta > 0n ? "+" : ""}${((Number(delta) / Number(before)) * 100).toFixed(2)}%)`;
  return `${before} → ${after}, ${delta > 0n ? "+" : ""}${delta}${pct}`;
}

/**
 * Record `gas` under `label` according to the mode. In `check` mode a missing or different
 * entry throws {@link ForkitAssertionError}.
 */
export async function recordGas(
  settings: GasSnapshotSettings,
  label: string,
  gas: bigint,
): Promise<void> {
  if (label === "" || label.trim() !== label || /[\r\n]/.test(label)) {
    throw new ForkitError(
      `forkit: gas snapshot label ${JSON.stringify(label)} must be one non-empty line without surrounding spaces`,
    );
  }
  if (settings.mode === "off") return;
  if (settings.mode === "check") {
    const recorded = read(settings.file).get(label);
    if (recorded === undefined) {
      throw new ForkitAssertionError(
        `forkit: no gas snapshot for "${label}" in ${settings.file}. Record it with ${GAS_SNAPSHOT_ENV}=write and commit the file.`,
      );
    }
    if (recorded !== gas) {
      throw new ForkitAssertionError(
        `forkit: gas for "${label}" changed: ${describeDelta(recorded, gas)}. If intended, re-record with ${GAS_SNAPSHOT_ENV}=write.`,
        { actual: gas, expected: recorded },
      );
    }
    return;
  }
  await withLock(settings.file, () => {
    const entries = read(settings.file);
    if (entries.get(label) === gas) return;
    entries.set(label, gas);
    const tmp = `${settings.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, formatGasSnapshot(entries));
    renameSync(tmp, settings.file);
  });
}
