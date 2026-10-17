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
import { rawRequest } from "./client.js";
import { ForkitError } from "./errors.js";
import { attachForks, fork, resolveHandleSettings, toForkOptions } from "./fork.js";
/** Env var through which the global setup tells test workers where the shared forks are. */
export const SHARED_FORKS_ENV = "FORKIT_SHARED_FORKS";
function listOf(targets) {
    return (Array.isArray(targets) ? targets : [targets]).map((t) => toForkOptions(t));
}
/**
 * Boot forks for every test file to share. Call it from a global setup (vitest `globalSetup`,
 * jest `globalSetup`, a bun preload); workers started afterwards inherit the env entry and
 * attach with `describeFork(..., { shared: true })` or {@link attachSharedFork}.
 */
export async function startSharedForks(targets) {
    const list = listOf(targets);
    const handle = list.length === 1
        ? await fork(list[0])
        : await fork(list);
    const dir = mkdtempSync(join(tmpdir(), "forkit-shared-"));
    const state = {
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
    let stopped;
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
function readState(env) {
    const raw = env[SHARED_FORKS_ENV];
    if (raw === undefined || raw === "") {
        throw new ForkitError(`forkit: no shared fork is running (${SHARED_FORKS_ENV} is not set). Start one in a global setup with startSharedForks(), or drop { shared: true }.`);
    }
    const state = JSON.parse(raw);
    if (state.version !== 1)
        throw new ForkitError(`forkit: unsupported ${SHARED_FORKS_ENV} version`);
    return state;
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
/** Leases this process holds, by lock path, with a count: nested describeFork blocks re-enter. */
const held = new Map();
async function acquireLease(dir, timeoutMs) {
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
        }
        catch {
            let owner = Number.NaN;
            try {
                owner = Number(readFileSync(join(lock, "owner"), "utf8"));
            }
            catch {
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
export const DEFAULT_LEASE_TIMEOUT_MS = 600_000;
/**
 * Attach to the shared forks for these chains, waiting for the lease. The handle behaves like
 * a booted fork, except that `stop()` reverts every chain to the state found at attach time and
 * hands the lease on; the anvil keeps running for the next file.
 */
export async function attachSharedFork(targets, options = {}) {
    const state = readState(options.env ?? process.env);
    const list = listOf(targets);
    const attach = list.map((opts) => {
        const shared = state.forks.find((f) => f.chainId === opts.chain.id);
        if (shared === undefined) {
            throw new ForkitError(`forkit: the shared forks are chains ${state.forks.map((f) => f.chainId).join(", ")}; ${opts.chain.name} (${opts.chain.id}) is not one of them.`);
        }
        if (opts.blockNumber !== undefined && shared.blockNumber !== opts.blockNumber.toString()) {
            throw new ForkitError(`forkit: the shared ${opts.chain.name} fork is pinned to block ${shared.blockNumber ?? "(live head)"}, not ${opts.blockNumber}.`);
        }
        return { options: opts, rpcUrl: shared.rpcUrl };
    });
    // A bad option must throw before the lease is taken, or every other file would wait on it.
    for (const { options: opts } of attach)
        resolveHandleSettings(opts);
    const releaseLease = await acquireLease(state.dir, options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS);
    let baselines = [];
    try {
        baselines = await Promise.all(attach.map(async ({ rpcUrl }) => {
            const request = rawRequest({ request: makeRequest(rpcUrl) });
            return [rpcUrl, (await request({ method: "evm_snapshot" }))];
        }));
    }
    catch (error) {
        releaseLease();
        throw error;
    }
    const handle = await attachForks(attach, async () => {
        try {
            await Promise.all(baselines.map(([rpcUrl, id]) => rawRequest({ request: makeRequest(rpcUrl) })({ method: "evm_revert", params: [id] })));
        }
        finally {
            releaseLease();
        }
    });
    return handle;
}
/** Minimal JSON-RPC over fetch, for the few calls made before a client exists. */
function makeRequest(url) {
    let id = 0;
    return async ({ method, params = [] }) => {
        const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        const body = (await response.json());
        if (body.error !== undefined)
            throw new ForkitError(`forkit: ${method} failed: ${body.error.message}`);
        return body.result;
    };
}
//# sourceMappingURL=shared.js.map