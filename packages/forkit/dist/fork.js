import { Instance } from "prool";
import { assertAnvilInstalled, freePort, isOpStack } from "./anvil.js";
import { expectBalanceChange } from "./assertions.js";
import { createForkClient, rawRequest, } from "./client.js";
import { dealErc20 } from "./deal.js";
import { ForkBootError, ForkCacheMissError, ForkitError } from "./errors.js";
import { emitForkitEvent, hasForkitListeners, observersSettled, } from "./events.js";
import { autoRecord } from "./explore/auto.js";
import { recordGas, resolveGasSettings } from "./gas.js";
import { label } from "./labels.js";
import { redactUrl, resolveForkUrl, rpcEnvVar } from "./rpc.js";
import { resolveCacheSettings, startRpcCache, } from "./rpc-cache.js";
import { formatTrace, traceTransaction } from "./trace.js";
export const DEFAULT_BOOT_TIMEOUT_MS = 120_000;
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;
function isForkOptions(target) {
    return "chain" in target && typeof target.chain === "object";
}
export function toForkOptions(target) {
    return isForkOptions(target) ? target : { chain: target };
}
/**
 * The anvil flags forkit passes. Exported for tests. `viaCache` means `url` is forkit's local
 * recording proxy: then anvil's own disk cache is off (it would hide requests from the
 * recording) and so is its rate limiter (the proxy is local).
 */
export function anvilParameters(options, url, port, viaCache = false) {
    return {
        binary: options.anvilBinary ?? "anvil",
        host: "127.0.0.1",
        port,
        forkUrl: url,
        ...(options.blockNumber === undefined ? {} : { forkBlockNumber: options.blockNumber }),
        // Only ever pass `true`: prool renders `false` as `--optimism false`, which anvil rejects.
        ...(isOpStack(options.chain) ? { optimism: true } : {}),
        ...(viaCache ? { noStorageCaching: true, noRateLimit: true } : {}),
    };
}
/**
 * Resolve a fork's options into handle settings. Called before anything boots or is leased, so a
 * bad option throws with nothing left running or held.
 */
export function resolveHandleSettings(options) {
    return {
        traces: resolveTraces(options.traces),
        gas: resolveGasSettings(options.gasSnapshot, options.gasSnapshotFile),
        warn: options.onWarn ?? ((message) => console.warn(message)),
    };
}
/** `traces` option, then `FORKIT_TRACES`, then `on-failure`. */
export function resolveTraces(option, env = process.env) {
    const value = option ?? env.FORKIT_TRACES ?? "on-failure";
    if (value !== "on-failure" && value !== "off") {
        throw new ForkitError(`forkit: traces must be "on-failure" or "off", got ${JSON.stringify(value)}`);
    }
    return value === "on-failure";
}
/** Gas used by a transaction: from its receipt, else (anvil 1.8 after evm_revert) its trace. */
async function gasUsedBy(request, tx) {
    const resolved = await (typeof tx === "function" ? tx() : tx);
    const hash = typeof resolved === "string" ? resolved : resolved.transactionHash;
    if (typeof resolved === "object" && typeof resolved.gasUsed === "bigint")
        return resolved.gasUsed;
    const receipt = (await request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null));
    if (receipt?.gasUsed !== undefined)
        return BigInt(receipt.gasUsed);
    const frame = await traceTransaction(request, hash);
    if (frame.gasUsed === undefined)
        throw new ForkitError(`forkit: no gas used for ${hash}`);
    return BigInt(frame.gasUsed);
}
function toCount(value, what) {
    const n = typeof value === "bigint" ? Number(value) : value;
    if (!Number.isSafeInteger(n) || n < 0) {
        throw new ForkitError(`forkit: ${what} must be a non-negative integer, got ${String(value)}`);
    }
    return n;
}
function withTimeout(promise, ms, onTimeout) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function killHard(instance) {
    try {
        instance._internal.process?.kill("SIGKILL");
    }
    catch {
        // Already gone.
    }
}
/** What `promise` rejected with, or `undefined` once it resolves. */
function failureOf(promise) {
    return (promise ?? Promise.resolve()).then(() => undefined, (error) => error);
}
/**
 * A boot failure. When stopping what did boot failed too (an offline fork cache that missed
 * the fork's first reads), the message says that as well: it is usually why the boot failed.
 */
function bootError(message, cause, stopFailure) {
    const also = stopFailure instanceof Error ? `\n${stopFailure.message}` : "";
    return new ForkBootError(`${message}${also}`, cause === undefined ? undefined : { cause });
}
/**
 * The forks booted by one `fork()` call. Every handle in a group can reach the others with
 * `on(chain)`, and stopping any of them stops them all.
 */
class ForkGroup {
    /** Indexed by position in the `fork()` call, not by boot order (chains boot in parallel). */
    #slots = [];
    #stoppers = [];
    get members() {
        return this.#slots.filter((m) => m !== undefined);
    }
    add(slot, member, stopSelf) {
        this.#slots[slot] = member;
        this.#stoppers.push(stopSelf);
    }
    /**
     * Idempotent: each member memoizes its own stop. Every member stops even when another one
     * fails, and the offline cache misses of every chain come back as one error.
     */
    async stop() {
        const results = await Promise.allSettled(this.#stoppers.map((stopSelf) => stopSelf()));
        const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
        if (failures.length > 1 && failures.every((f) => f instanceof ForkCacheMissError)) {
            throw new ForkCacheMissError(failures.flatMap((f) => f.misses));
        }
        if (failures.length > 0)
            throw failures[0];
    }
}
function describeChains(chains) {
    return chains.map((c) => `${c.name} (${c.id})`).join(", ");
}
class SingleFork {
    chain;
    rpcUrl;
    client;
    /** Same endpoint, typed against the wide `Chain` for chain-agnostic helpers. */
    #anyChainClient;
    #stopOwner;
    #cache;
    #gas;
    #pranks = new Map();
    #group;
    #traces;
    #warn;
    #stopping;
    constructor(chain, rpcUrl, 
    /** Stops the anvil behind this handle, or, for an attached handle, releases it. */
    stopOwner, cache, group, slot, traces, gas, warn) {
        this.chain = chain;
        this.rpcUrl = rpcUrl;
        this.#traces = traces;
        this.#warn = warn;
        this.client = createForkClient(chain, rpcUrl, undefined, traces, warn);
        this.#anyChainClient = createForkClient(chain, rpcUrl, undefined, traces, warn);
        this.#stopOwner = stopOwner;
        this.#cache = cache;
        this.#gas = gas;
        this.#group = group;
        group.add(slot, this, () => this.#stopSelf());
    }
    get forks() {
        return this.#group.members;
    }
    cacheStats() {
        return this.#cache?.stats();
    }
    async deal(token, holder, amount, options) {
        await dealErc20(this.#anyChainClient, token, holder, amount, options);
        this.#emitDeal(token, holder, amount);
    }
    async dealNative(holder, amount) {
        await this.client.setBalance({ address: holder, value: amount });
        this.#emitDeal("native", holder, amount);
    }
    #emitDeal(token, holder, amount) {
        emitForkitEvent({
            type: "deal",
            ts: Date.now(),
            chainId: this.chain.id,
            rpcUrl: this.rpcUrl,
            token,
            holder,
            amount,
        });
    }
    async prank(account, fn) {
        const key = account.toLowerCase();
        const depth = this.#pranks.get(key) ?? 0;
        if (depth === 0)
            await this.client.impersonateAccount({ address: account });
        this.#pranks.set(key, depth + 1);
        this.#emitCheat({ cheat: "prank", account });
        let result;
        try {
            result = await fn(createForkClient(this.chain, this.rpcUrl, account, this.#traces, this.#warn));
        }
        catch (error) {
            // fn's error is the one that matters; a failure to stop impersonating must not hide it.
            await this.#endPrank(key, account).catch(() => { });
            throw error;
        }
        await this.#endPrank(key, account);
        return result;
    }
    async #endPrank(key, account) {
        this.#emitCheat({ cheat: "stopPrank", account });
        const remaining = (this.#pranks.get(key) ?? 1) - 1;
        if (remaining > 0) {
            this.#pranks.set(key, remaining);
            return;
        }
        this.#pranks.delete(key);
        await this.client.stopImpersonatingAccount({ address: account });
    }
    async warp(seconds) {
        const count = toCount(seconds, "warp seconds");
        await this.client.increaseTime({ seconds: count });
        await this.client.mine({ blocks: 1 });
        this.#emitCheat({ cheat: "warp", seconds: BigInt(count), ...(await this.#head()) });
    }
    async roll(blocks) {
        const count = toCount(blocks, "roll blocks");
        if (count > 0)
            await this.client.mine({ blocks: count });
        this.#emitCheat({ cheat: "roll", blocks: BigInt(count), ...(await this.#head()) });
    }
    /** The latest block's number and timestamp, for a cheat event (only while someone listens). */
    async #head() {
        if (!hasForkitListeners())
            return {};
        try {
            const block = await this.client.getBlock();
            return { blockNumber: block.number, timestamp: block.timestamp };
        }
        catch {
            return {};
        }
    }
    #emitCheat(event) {
        emitForkitEvent({
            type: "cheat",
            ts: Date.now(),
            chainId: this.chain.id,
            rpcUrl: this.rpcUrl,
            ...event,
        });
    }
    label(address, name) {
        label(address, name);
    }
    async trace(hash) {
        return formatTrace(await traceTransaction(rawRequest(this.client), hash));
    }
    expectBalanceChange(token, holder, delta, fn) {
        return expectBalanceChange(this.client, token, holder, delta, fn);
    }
    async gasSnapshot(label, tx) {
        const gas = await gasUsedBy(rawRequest(this.client), tx);
        await recordGas(this.#gas, label, gas);
        return gas;
    }
    async snapshot() {
        const id = await this.#snapshot();
        this.#emitCheat({ cheat: "snapshot", snapshotId: id });
        return id;
    }
    async revertTo(id) {
        await this.#revertTo(id);
        this.#emitCheat({ cheat: "revert", snapshotId: id });
    }
    #snapshot() {
        return this.client.snapshot();
    }
    async #revertTo(id) {
        // Observers (a run record) read receipts and traces of what the revert is about to undo.
        await observersSettled();
        const ok = await rawRequest(this.client)({ method: "evm_revert", params: [id] });
        if (ok !== true) {
            throw new ForkitError(`forkit: anvil has no snapshot ${id}. A revert consumes the snapshot and every later one; take a new snapshot before reverting again.`);
        }
    }
    /** A snapshot for per-test isolation: no run event, it is not the test's own cheat. */
    static isolationSnapshot(fork) {
        return fork instanceof SingleFork ? fork.#snapshot() : fork.snapshot();
    }
    /** Revert a per-test isolation snapshot, with no run event. */
    static isolationRevert(fork, id) {
        return fork instanceof SingleFork ? fork.#revertTo(id) : fork.revertTo(id);
    }
    on(chain) {
        const member = this.#group.members.find((m) => m.chain.id === chain.id);
        if (member === undefined) {
            throw new ForkitError(`forkit: this handle forks ${describeChains(this.#group.members.map((m) => m.chain))}, not ${chain.name} (${chain.id}).`);
        }
        return member;
    }
    /** Stop every fork in the handle (for a multi-chain fork, all of them). Idempotent. */
    stop() {
        return this.#group.stop();
    }
    #stopSelf() {
        this.#stopping ??= observersSettled()
            .then(() => this.#stopOwner())
            .then(() => this.#cache?.close());
        return this.#stopping;
    }
}
async function forkOne(target, group, slot) {
    const options = toForkOptions(target);
    const { chain } = options;
    const warn = options.onWarn ?? ((message) => console.warn(message));
    assertAnvilInstalled(options.anvilBinary);
    const rpc = resolveForkUrl(chain, options.forkUrl);
    if (options.blockNumber === undefined) {
        warn(`forkit: forking ${chain.name} (${chain.id}) at the live head. This run is not reproducible; pin blockNumber.`);
    }
    // Resolve every option before anything boots: a bad value must throw with no anvil (or RPC
    // cache) left running behind it.
    const cacheSettings = resolveCacheSettings(options.cache, options.cacheDir);
    const settings = resolveHandleSettings(options);
    const cache = options.blockNumber === undefined || cacheSettings.mode === "off"
        ? undefined
        : await startRpcCache({
            upstream: rpc.url,
            chainId: chain.id,
            blockNumber: options.blockNumber,
            mode: cacheSettings.mode,
            dir: cacheSettings.dir,
            port: await freePort(),
        });
    const port = await freePort();
    const instance = Instance.anvil(anvilParameters(options, cache?.url ?? rpc.url, port, cache !== undefined));
    const bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    const where = `${chain.name} (${chain.id}) via ${redactUrl(rpc.url)}${options.blockNumber === undefined ? "" : ` at block ${options.blockNumber}`}`;
    const bootStarted = Date.now();
    try {
        await withTimeout(instance.start(), bootTimeoutMs, () => new ForkBootError(`forkit: anvil did not become ready within ${bootTimeoutMs}ms forking ${where}. Public RPCs are slow and rate limited; set ${rpcEnvVar(chain.id)} to a paid endpoint or raise bootTimeoutMs.`));
    }
    catch (error) {
        killHard(instance);
        const stopFailure = await failureOf(cache?.close());
        if (error instanceof ForkBootError) {
            throw stopFailure === undefined ? error : bootError(error.message, error.cause, stopFailure);
        }
        throw bootError(`forkit: anvil failed to fork ${where}`, error, stopFailure);
    }
    const rpcUrl = `http://127.0.0.1:${port}`;
    const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    const handle = new SingleFork(chain, rpcUrl, () => withTimeout(instance.stop(), stopTimeoutMs, () => new ForkitError(`forkit: anvil did not stop within ${stopTimeoutMs}ms`)).catch(() => {
        // Graceful stop wedged or failed: make sure the process is gone, never hang the suite.
        killHard(instance);
    }), cache, group, slot, settings.traces, settings.gas, settings.warn);
    const servedChainId = await handle.client.getChainId().catch(async (error) => {
        const stopFailure = await failureOf(handle.stop());
        throw bootError(`forkit: anvil started but does not answer on ${rpcUrl}`, error, stopFailure);
    });
    if (servedChainId !== chain.id) {
        const stopFailure = await failureOf(handle.stop());
        throw bootError(`forkit: ${redactUrl(rpc.url)} serves chain ${servedChainId}, but the fork asked for ${chain.name} (${chain.id}).`, undefined, stopFailure);
    }
    const cacheStats = handle.cacheStats();
    emitForkitEvent({
        type: "fork:boot",
        ts: Date.now(),
        chainId: chain.id,
        chainName: chain.name,
        ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
        upstream: redactUrl(rpc.url),
        rpcUrl,
        ...(cacheStats === undefined ? {} : { cache: cacheStats }),
        bootMs: Date.now() - bootStarted,
        nativeSymbol: chain.nativeCurrency.symbol,
    });
    return handle;
}
/**
 * Handles on anvils forkit did not start. `stop()` on any of them calls `release` once and never
 * kills the process.
 */
export async function attachForks(targets, release) {
    autoRecord();
    const settings = targets.map(({ options }) => resolveHandleSettings(options));
    const group = new ForkGroup();
    let released;
    const releaseOnce = () => {
        released ??= release();
        return released;
    };
    const handles = targets.map(({ options, rpcUrl }, slot) => new SingleFork(options.chain, rpcUrl, releaseOnce, undefined, group, slot, settings[slot].traces, settings[slot].gas, settings[slot].warn));
    for (const handle of handles) {
        const served = await handle.client.getChainId().catch(async (error) => {
            await releaseOnce();
            throw new ForkBootError(`forkit: no anvil answers on ${handle.rpcUrl}`, { cause: error });
        });
        if (served !== handle.chain.id) {
            await releaseOnce();
            throw new ForkBootError(`forkit: ${handle.rpcUrl} serves chain ${served}, but ${handle.chain.name} (${handle.chain.id}) was asked for.`);
        }
    }
    const first = handles[0];
    if (first === undefined)
        throw new ForkitError("forkit: nothing to attach to.");
    return first;
}
export async function fork(target) {
    autoRecord();
    const group = new ForkGroup();
    if (!Array.isArray(target))
        return await forkOne(target, group, 0);
    const targets = target;
    if (targets.length === 0)
        throw new ForkitError("forkit: fork([]) needs at least one chain.");
    const chains = targets.map((t) => toForkOptions(t).chain);
    const seen = new Set();
    for (const chain of chains) {
        if (seen.has(chain.id)) {
            throw new ForkitError(`forkit: fork([...]) lists chain ${chain.id} twice (${describeChains(chains)}). Each chain gets one fork; select it with on(chain).`);
        }
        seen.add(chain.id);
    }
    const booted = await Promise.allSettled(targets.map((t, slot) => forkOne(t, group, slot)));
    const failed = booted.find((r) => r.status === "rejected");
    if (failed !== undefined) {
        // The failed chain's error already names what its own cache missed; it is the one to throw.
        await failureOf(group.stop());
        throw failed.reason;
    }
    return booted[0].value;
}
/** Snapshot every test's starting state without recording a cheat (see `describeFork`). */
export const isolationSnapshot = (fork) => SingleFork.isolationSnapshot(fork);
/** Revert to a test's starting state without recording a cheat. */
export const isolationRevert = (fork, id) => SingleFork.isolationRevert(fork, id);
//# sourceMappingURL=fork.js.map