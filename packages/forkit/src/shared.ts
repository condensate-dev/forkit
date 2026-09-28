/**
 * One fork shared by every test file: a global setup boots it once (fork sync against a public
 * RPC is the slow part), and each file attaches by URL instead of booting its own anvil.
 *
 * Files may run in parallel, but a fork has one state, and a file's snapshot/revert would undo
 * another file's work. So attaching takes an exclusive lease: files take turns on the fork, and
 * each one reverts it to the state it found before handing it on.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chain } from "viem";
import { rawRequest } from "./client.ts";
import { ForkitError } from "./errors.ts";
import { attachForks, fork, resolveHandleSettings, toForkOptions } from "./fork.ts";
import type { Fork, ForkOptions, ForkTarget, SnapshotId } from "./types.ts";

/** Env var through which the global setup tells test workers where the shared forks are. */
export const SHARED_FORKS_ENV = "FORKIT_SHARED_FORKS";

interface SharedState {
  version: 1;
  forks: { chainId: number; rpcUrl: string; blockNumber?: string }[];
  /** Directory whose `lease` subdirectory is the lock. */
  dir: string;
}

export interface SharedForks {
  /** The env entry workers need; already set on `process.env`. */
  readonly env: Readonly<Record<string, string>>;
  /** The fork handle (for the global setup's own use). */
  readonly fork: Fork;
  /** Stop the forks and clean up. Return this from a vitest globalSetup, or call it in teardown. */
  stop(): Promise<void>;
}

type Targets = ForkTarget | readonly [ForkTarget, ...ForkTarget[]];

function listOf(targets: Targets): ForkOptions[] {
  return (
    Array.isArray(targets) ? (targets as readonly ForkTarget[]) : [targets as ForkTarget]
  ).map((t) => toForkOptions(t));
}

/**
 * Boot forks for every test file to share. Call it from a global setup (vitest `globalSetup`,
 * jest `globalSetup`, a bun preload); workers started afterwards inherit the env entry and
 * attach with `describeFork(..., { shared: true })` or {@link attachSharedFork}.
 */
export async function startSharedForks(targets: Targets): Promise<SharedForks> {
  const list = listOf(targets);
  const handle =
    list.length === 1
      ? await fork(list[0] as ForkOptions)
      : await fork(list as unknown as readonly [ForkTarget, ...ForkTarget[]]);
  const dir = mkdtempSync(join(tmpdir(), "forkit-shared-"));
  const state: SharedState = {
    version: 1,
    dir,
    forks: handle.forks.map((f, i) => {
      const blockNumber = list[i]?.blockNumber;
      return {
        chainId: f.chain.id,
        rpcUrl: f.rpcUrl,
        ...(blockNumber === undefined ? {} : { blockNumber: blockNumber.toString() }),
      };
    }),
  };
  const env = { [SHARED_FORKS_ENV]: JSON.stringify(state) };
  process.env[SHARED_FORKS_ENV] = env[SHARED_FORKS_ENV];
  let stopped: Promise<void> | undefined;
  return {
    env,
    fork: handle,
    stop() {
      stopped ??= handle.stop().finally(() => {
        rmSync(dir, { recursive: true, force: true });
        if (process.env[SHARED_FORKS_ENV] === env[SHARED_FORKS_ENV])
          delete process.env[SHARED_FORKS_ENV];
      });
      return stopped;
    },
  };
}

function readState(env: Readonly<Record<string, string | undefined>>): SharedState {
  const raw = env[SHARED_FORKS_ENV];
  if (raw === undefined || raw === "") {
    throw new ForkitError(
      `forkit: no shared fork is running (${SHARED_FORKS_ENV} is not set). Start one in a global setup with startSharedForks(), or drop { shared: true }.`,
    );
  }
  const state = JSON.parse(raw) as SharedState;
  if (state.version !== 1) throw new ForkitError(`forkit: unsupported ${SHARED_FORKS_ENV} version`);
  return state;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/** Leases this process holds, by lock path, with a count: nested describeFork blocks re-enter. */
const held = new Map<string, number>();

async function acquireLease(dir: string, timeoutMs: number): Promise<() => void> {
  const lock = join(dir, "lease");
  const release = () => {
    const count = (held.get(lock) ?? 1) - 1;
    if (count > 0) {
      held.set(lock, count);
      return;
    }
    held.delete(lock);
    rmSync(lock, { recursive: true, force: true });
  };
  const count = held.get(lock);
  if (count !== undefined) {
    held.set(lock, count + 1);
    return release;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), String(process.pid));
      held.set(lock, 1);
      return release;
    } catch {
      let owner = Number.NaN;
      try {
        owner = Number(readFileSync(join(lock, "owner"), "utf8"));
      } catch {
        // Being created or released right now.
      }
      // A worker that died holding the lease must not block everyone else.
      if (Number.isSafeInteger(owner) && !alive(owner))
        rmSync(lock, { recursive: true, force: true });
      if (Date.now() > deadline) {
        throw new ForkitError(`forkit: waited ${timeoutMs}ms for the shared fork lease (${lock}).`);
      }
      await new Promise((ok) => setTimeout(ok, 25));
    }
  }
}

export interface AttachOptions {
  /** How long to wait for other files to hand the shared fork over. Default 10 minutes. */
  leaseTimeoutMs?: number;
  /** Where to read the shared state from. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export const DEFAULT_LEASE_TIMEOUT_MS = 600_000;

/**
 * Attach to the shared forks for these chains, waiting for the lease. The handle behaves like
 * a booted fork, except that `stop()` reverts every chain to the state found at attach time and
 * hands the lease on; the anvil keeps running for the next file.
 */
export async function attachSharedFork<TChain extends Chain>(
  targets: ForkTarget<TChain> | readonly [ForkTarget<TChain>, ...ForkTarget[]],
  options: AttachOptions = {},
): Promise<Fork<TChain>> {
  const state = readState(options.env ?? process.env);
  const list = listOf(targets as Targets);
  const attach = list.map((opts) => {
    const shared = state.forks.find((f) => f.chainId === opts.chain.id);
    if (shared === undefined) {
      throw new ForkitError(
        `forkit: the shared forks are chains ${state.forks.map((f) => f.chainId).join(", ")}; ${opts.chain.name} (${opts.chain.id}) is not one of them.`,
      );
    }
    if (opts.blockNumber !== undefined && shared.blockNumber !== opts.blockNumber.toString()) {
      throw new ForkitError(
        `forkit: the shared ${opts.chain.name} fork is pinned to block ${shared.blockNumber ?? "(live head)"}, not ${opts.blockNumber}.`,
      );
    }
    return { options: opts, rpcUrl: shared.rpcUrl };
  });

  // A bad option must throw before the lease is taken, or every other file would wait on it.
  for (const { options: opts } of attach) resolveHandleSettings(opts);
  const releaseLease = await acquireLease(
    state.dir,
    options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS,
  );
  let baselines: [string, SnapshotId][] = [];
  try {
    baselines = await Promise.all(
      attach.map(async ({ rpcUrl }): Promise<[string, SnapshotId]> => {
        const request = rawRequest({ request: makeRequest(rpcUrl) });
        return [rpcUrl, (await request({ method: "evm_snapshot" })) as SnapshotId];
      }),
    );
  } catch (error) {
    releaseLease();
    throw error;
  }
  const handle = await attachForks(attach, async () => {
    try {
      await Promise.all(
        baselines.map(([rpcUrl, id]) =>
          rawRequest({ request: makeRequest(rpcUrl) })({ method: "evm_revert", params: [id] }),
        ),
      );
    } finally {
      releaseLease();
    }
  });
  return handle as unknown as Fork<TChain>;
}

/** Minimal JSON-RPC over fetch, for the few calls made before a client exists. */
function makeRequest(url: string) {
  let id = 0;
  return async ({ method, params = [] }: { method: string; params?: readonly unknown[] }) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error !== undefined)
      throw new ForkitError(`forkit: ${method} failed: ${body.error.message}`);
    return body.result;
  };
}
