import { spawnSync } from "node:child_process";
import { SurfpoolNotFoundError } from "./errors.ts";

/**
 * The surfpool release forkit/svm is built and tested against. Its RPC method names come from
 * that tag's source (crates/core/src/rpc). CI installs exactly this release
 * (scripts/install-surfpool.sh); older releases are refused, newer ones are allowed.
 */
export const SURFPOOL_VERSION = "1.6.1";

/** The surfpool binary: the option, else `FORKIT_SURFPOOL_BIN`, else `surfpool` on PATH. */
export function resolveSurfpoolBinary(
  option?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (option !== undefined && option !== "") return option;
  const fromEnv = env.FORKIT_SURFPOOL_BIN;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : "surfpool";
}

/** `[major, minor, patch]` from a version string such as `surfpool 1.6.1`, or `undefined`. */
export function parseSurfpoolVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function olderThan(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

const checked = new Map<string, string>();

/**
 * Throw {@link SurfpoolNotFoundError} unless `surfpool --version` runs and reports
 * {@link SURFPOOL_VERSION} or newer. Synchronous, so a runner adapter can call it while collecting
 * tests: a missing surfpool is a collection error, never a skipped suite. Returns the version.
 */
export function assertSurfpoolInstalled(binary = resolveSurfpoolBinary()): string {
  const cached = checked.get(binary);
  if (cached !== undefined) return cached;
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw new SurfpoolNotFoundError(
      binary,
      "could not run `surfpool --version`",
      result.error ?? result.stderr,
    );
  }
  const line = result.stdout.split("\n")[0]?.trim() ?? "";
  const version = parseSurfpoolVersion(line);
  const pinned = parseSurfpoolVersion(SURFPOOL_VERSION) ?? [0, 0, 0];
  if (version === undefined || olderThan(version, pinned)) {
    throw new SurfpoolNotFoundError(
      binary,
      `surfpool reported ${JSON.stringify(line)}; forkit/svm needs ${SURFPOOL_VERSION} or newer`,
    );
  }
  const found = version.join(".");
  checked.set(binary, found);
  return found;
}
