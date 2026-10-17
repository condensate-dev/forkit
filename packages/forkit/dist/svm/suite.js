import { ForkitError } from "../errors.js";
import { DEFAULT_SURFNET_BOOT_TIMEOUT_MS, DEFAULT_SURFNET_STOP_TIMEOUT_MS, surfnet, } from "./surfnet.js";
import { assertSurfpoolInstalled, resolveSurfpoolBinary } from "./surfpool.js";
const EACH_HOOK_TIMEOUT_MS = 30_000;
/** Slack on top of forkit's own ceilings, so forkit's error wins the race against the runner's. */
const HOOK_SLACK_MS = 5_000;
const NOT_RUNNING = "forkit: the surfnet is not running. Use it inside a test or hook, not while tests are being collected.";
/** A {@link Surfnet} that forwards to the one booted in `beforeAll`; throws before then. */
class DeferredSurfnet {
    #resolve;
    constructor(resolve) {
        this.#resolve = resolve;
    }
    get #surfnet() {
        const current = this.#resolve();
        if (current === undefined)
            throw new ForkitError(NOT_RUNNING);
        return current;
    }
    get rpcUrl() {
        return this.#surfnet.rpcUrl;
    }
    get wsUrl() {
        return this.#surfnet.wsUrl;
    }
    get source() {
        return this.#surfnet.source;
    }
    get surfpoolVersion() {
        return this.#surfnet.surfpoolVersion;
    }
    get rpc() {
        return this.#surfnet.rpc;
    }
    get rpcSubscriptions() {
        return this.#surfnet.rpcSubscriptions;
    }
    request(method, params) {
        return this.#surfnet.request(method, params);
    }
    info() {
        return this.#surfnet.info();
    }
    stop() {
        return this.#surfnet.stop();
    }
    setAccount(account, patch) {
        return this.#surfnet.setAccount(account, patch);
    }
    dealSol(account, lamports) {
        return this.#surfnet.dealSol(account, lamports);
    }
    deal(mint, owner, amount, options) {
        return this.#surfnet.deal(mint, owner, amount, options);
    }
    clock() {
        return this.#surfnet.clock();
    }
    warp(seconds) {
        return this.#surfnet.warp(seconds);
    }
    roll(slots) {
        return this.#surfnet.roll(slots);
    }
    warpTo(target) {
        return this.#surfnet.warpTo(target);
    }
    pauseClock() {
        return this.#surfnet.pauseClock();
    }
    resumeClock() {
        return this.#surfnet.resumeClock();
    }
    etch(programId, program, options) {
        return this.#surfnet.etch(programId, program, options);
    }
    setProgramAuthority(programId, authority) {
        return this.#surfnet.setProgramAuthority(programId, authority);
    }
    reset(account, options) {
        return this.#surfnet.reset(account, options);
    }
}
/**
 * Register one surfnet's lifecycle on a runner's hooks and return its handle. Call it while tests
 * are being collected: a missing or too-old surfpool throws right here, so the suite fails
 * loudly instead of skipping.
 */
export function createSurfnetSuite(options, hooks) {
    assertSurfpoolInstalled(resolveSurfpoolBinary(options.surfpoolBinary));
    let current;
    hooks.beforeAll(async () => {
        current = await surfnet(options);
    }, (options.bootTimeoutMs ?? DEFAULT_SURFNET_BOOT_TIMEOUT_MS) + HOOK_SLACK_MS);
    hooks.afterAll(async () => {
        try {
            await current?.stop();
        }
        finally {
            current = undefined;
        }
    }, (options.stopTimeoutMs ?? DEFAULT_SURFNET_STOP_TIMEOUT_MS) + HOOK_SLACK_MS);
    if (options.resetEach === true) {
        hooks.afterEach(async () => {
            await current?.reset();
        }, EACH_HOOK_TIMEOUT_MS);
    }
    return new DeferredSurfnet(() => current);
}
//# sourceMappingURL=suite.js.map