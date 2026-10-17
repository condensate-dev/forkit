import { assertAnvilInstalled } from "./anvil.js";
import { ForkitError } from "./errors.js";
import { DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS, fork, isolationRevert, isolationSnapshot, toForkOptions, } from "./fork.js";
import { attachSharedFork, DEFAULT_LEASE_TIMEOUT_MS } from "./shared.js";
/** Slack on top of forkit's own ceilings, so forkit's error wins the race against the runner's. */
const HOOK_SLACK_MS = 5_000;
const EACH_HOOK_TIMEOUT_MS = 30_000;
const NOT_RUNNING = "forkit: the fork is not running. Use it inside a test or hook, not while tests are being collected.";
/**
 * A {@link Fork} that forwards to the fork booted in `beforeAll`. Using it before then (e.g. at
 * collection time) throws, except `on(chain)`, which returns another deferred handle.
 */
class DeferredFork {
    chain;
    #resolve;
    constructor(chain, resolve) {
        this.chain = chain;
        this.#resolve = resolve;
    }
    get #fork() {
        const current = this.#resolve();
        if (current === undefined)
            throw new ForkitError(NOT_RUNNING);
        return current;
    }
    get forks() {
        return this.#fork.forks;
    }
    get rpcUrl() {
        return this.#fork.rpcUrl;
    }
    cacheStats() {
        return this.#fork.cacheStats();
    }
    get client() {
        return this.#fork.client;
    }
    deal(token, holder, amount, options) {
        return this.#fork.deal(token, holder, amount, options);
    }
    dealNative(holder, amount) {
        return this.#fork.dealNative(holder, amount);
    }
    prank(account, fn) {
        return this.#fork.prank(account, fn);
    }
    warp(seconds) {
        return this.#fork.warp(seconds);
    }
    roll(blocks) {
        return this.#fork.roll(blocks);
    }
    label(address, name) {
        this.#fork.label(address, name);
    }
    trace(hash) {
        return this.#fork.trace(hash);
    }
    expectBalanceChange(token, holder, delta, fn) {
        return this.#fork.expectBalanceChange(token, holder, delta, fn);
    }
    gasSnapshot(label, tx) {
        return this.#fork.gasSnapshot(label, tx);
    }
    snapshot() {
        return this.#fork.snapshot();
    }
    revertTo(id) {
        return this.#fork.revertTo(id);
    }
    on(chain) {
        const current = this.#resolve();
        // Running: select now, so an unknown chain throws here. Collecting: defer, checked on use.
        if (current !== undefined)
            return current.on(chain);
        return new DeferredFork(chain, () => this.#resolve()?.on(chain));
    }
    stop() {
        return this.#fork.stop();
    }
}
/**
 * Runner-agnostic fork lifecycle: boot once per suite, snapshot/revert every chain around every
 * test, stop at the end. Call it while tests are being collected: a missing anvil throws right
 * here, so the suite fails loudly instead of skipping.
 */
export function createForkSuite(targets, hooks, options = {}) {
    const list = (Array.isArray(targets) ? targets : [targets]).map((t) => toForkOptions(t));
    const first = list[0];
    if (first === undefined)
        throw new ForkitError("forkit: a fork suite needs at least one chain.");
    const shared = options.shared === true ? {} : options.shared === false ? undefined : options.shared;
    if (shared === undefined) {
        for (const binary of new Set(list.map((o) => o.anvilBinary)))
            assertAnvilInstalled(binary);
    }
    let current;
    const handle = new DeferredFork(first.chain, () => current);
    let snapshots = [];
    // Chains boot in parallel, so the slowest one sets the ceiling.
    const bootMs = Math.max(...list.map((o) => o.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS));
    const stopMs = Math.max(...list.map((o) => o.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS));
    const tuple = list;
    hooks.beforeAll(async () => {
        const booted = shared !== undefined
            ? await attachSharedFork(tuple, shared)
            : list.length === 1
                ? await fork(first)
                : await fork(tuple);
        current = booted;
    }, (shared === undefined ? bootMs : (shared.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS)) +
        HOOK_SLACK_MS);
    // stop() throws ForkCacheMissError when an offline fork missed its recording: the suite fails.
    hooks.afterAll(async () => {
        try {
            await current?.stop();
        }
        finally {
            current = undefined;
        }
    }, stopMs + HOOK_SLACK_MS);
    if (options.isolate !== false) {
        hooks.beforeEach(async () => {
            if (current === undefined)
                return;
            snapshots = await Promise.all(current.forks.map(async (f) => [f, await isolationSnapshot(f)]));
        }, EACH_HOOK_TIMEOUT_MS);
        hooks.afterEach(async () => {
            const taken = snapshots;
            snapshots = [];
            await Promise.all(taken.map(([f, id]) => isolationRevert(f, id)));
        }, EACH_HOOK_TIMEOUT_MS);
    }
    return handle;
}
//# sourceMappingURL=suite.js.map