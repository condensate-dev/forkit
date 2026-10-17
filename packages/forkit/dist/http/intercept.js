/**
 * `fetch` interception for quote-API record and replay.
 *
 * `globalThis.fetch` is swapped for a wrapper, so production code's own `fetch` calls are
 * intercepted unchanged, with no import changes and no runtime dependency. Only one fixture set
 * is active at a time: two layers of mocks over one global would make it unclear who answered.
 */
import { ForkitError } from "../errors.js";
import { emitForkitEvent } from "../events.js";
import { decodeBody, encodeBody, fixturePath, matchKey, readFixtureFile, responseHeaders, writeFixtureFile, } from "./fixtures.js";
import { createRedactor } from "./redact.js";
export const HTTP_MODES = ["record", "replay", "auto", "off"];
/** Env override for the mode, e.g. `FORKIT_HTTP=replay` in CI. */
export const HTTP_MODE_ENV = "FORKIT_HTTP";
/** Env override for the fixture directory. */
export const HTTP_DIR_ENV = "FORKIT_HTTP_DIR";
/** Default fixture directory, relative to the working directory. Meant to be committed. */
export const DEFAULT_HTTP_DIR = ".forkit-http";
/** A request with no recording, in `replay` mode with `unmatched: "error"`. */
export class HttpUnmatchedError extends ForkitError {
    name = "HttpUnmatchedError";
    method;
    /** Redacted URL. */
    url;
    /** The fixture file that has no recording for it. */
    path;
    constructor(method, url, path, fileExists) {
        super([
            `forkit/http: no recording for ${method} ${url}`,
            `  in ${path}${fileExists ? "" : " (the file does not exist)"}.`,
            `Record it by running once with ${HTTP_MODE_ENV}=record (or auto) and network access, or pass unmatched: "passthrough".`,
        ].join("\n"));
        this.method = method;
        this.url = url;
        this.path = path;
    }
}
/** Resolve the mode and directory from options, then env, then defaults. */
export function resolveHttpSettings(mode, dir, env = process.env) {
    const envMode = env[HTTP_MODE_ENV];
    if (mode === undefined && envMode !== undefined && envMode !== "") {
        if (!HTTP_MODES.includes(envMode)) {
            throw new ForkitError(`forkit: ${HTTP_MODE_ENV}=${envMode} is not one of ${HTTP_MODES.join(", ")}`);
        }
    }
    const ci = env.CI !== undefined && env.CI !== "" && env.CI !== "false" && env.CI !== "0";
    const resolvedMode = mode ?? (envMode ? envMode : ci ? "replay" : "auto");
    return { mode: resolvedMode, dir: dir ?? env[HTTP_DIR_ENV] ?? DEFAULT_HTTP_DIR };
}
/**
 * Statuses `auto` does not record: auth failures (no API key locally), rate limits and server
 * errors are about the run, not the quote. `record` saves whatever it gets.
 */
function isTransient(status) {
    return status === 401 || status === 403 || status === 407 || status === 429 || status >= 500;
}
/** Statuses whose Response must have a null body. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
/**
 * JSON-RPC is the fork's own traffic (viem clients, the fork cache's upstream), not a quote API;
 * the fork cache records it, keyed by block, so it is never intercepted here.
 */
function isJsonRpc(body) {
    const first = Array.isArray(body) ? body[0] : body;
    return typeof first === "object" && first !== null && "jsonrpc" in first && "method" in first;
}
/** The active set, on a global symbol so two copies of this module still see each other. */
const ACTIVE = Symbol.for("@condensate/forkit/http:active");
async function toFixtureRequest(request, redactor) {
    const bytes = request.body === null ? new Uint8Array() : new Uint8Array(await request.clone().arrayBuffer());
    return {
        method: request.method.toUpperCase(),
        url: redactor.url(request.url),
        headers: redactor.headers(request.headers),
        ...encodeBody(bytes, request.headers.get("content-type")),
    };
}
function toResponse(recorded, url) {
    const body = NULL_BODY_STATUS.has(recorded.status) ? undefined : decodeBody(recorded);
    const response = new Response(body ?? null, {
        status: recorded.status,
        statusText: recorded.statusText,
        headers: recorded.headers,
    });
    // A constructed Response has an empty `url`; code that logs or branches on it sees the real one.
    Object.defineProperty(response, "url", { value: url });
    return response;
}
function toBigInt(value, what) {
    if (typeof value === "bigint")
        return value;
    if (Number.isSafeInteger(value) && value >= 0)
        return BigInt(value);
    throw new ForkitError(`forkit/http: ${what} must be a non-negative integer, got ${value}`);
}
function keySort(a, b) {
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
/** Start a fixture set in the mode from `options`, `FORKIT_HTTP`, or the default. */
export function use(options) {
    if (typeof options?.name !== "string" || options.blockNumber === undefined) {
        throw new ForkitError("forkit/http: pass a fixture set `name` and the fork's `blockNumber`");
    }
    const settings = resolveHttpSettings(options.mode, options.dir);
    const { mode } = settings;
    const path = fixturePath(settings.dir, options.name);
    const blockNumber = toBigInt(options.blockNumber, "blockNumber");
    const warn = options.onWarn ?? ((message) => console.warn(message));
    const redactor = createRedactor(options.redact);
    const match = options;
    const keyOf = (request) => matchKey(request, redactor, match);
    let hits = 0;
    let passthrough = 0;
    const unmatched = [];
    const session = new Map();
    const recordedCount = () => [...session.values()].reduce((n, list) => n + list.length, 0);
    let stopped;
    if (mode === "off") {
        return {
            name: options.name,
            mode,
            path,
            stats: () => ({
                name: options.name,
                path,
                mode,
                hits,
                recorded: 0,
                passthrough,
                unmatched,
                entries: 0,
            }),
            stop: () => (stopped ??= Promise.resolve()),
        };
    }
    const global = globalThis;
    const active = global[ACTIVE];
    if (active !== undefined) {
        throw new ForkitError(`forkit/http: fetch is already intercepted by fixture set "${active.name}" (${active.path}). Stop it before starting "${options.name}"; one set is active at a time.`);
    }
    const file = readFixtureFile(path);
    const sameBlock = file !== undefined &&
        file.blockNumber === blockNumber.toString() &&
        (file.chainId === undefined ||
            options.chainId === undefined ||
            file.chainId === options.chainId);
    const at = (block, chainId) => `block ${block}${chainId === undefined ? "" : ` (chain ${chainId})`}`;
    const recordedAt = file === undefined ? "" : at(file.blockNumber, file.chainId);
    const runningAt = at(blockNumber.toString(), options.chainId);
    // Recordings at another block are stale for this fork. `record` replaces them; the others
    // serve them (quotes may no longer fill) and say so, and `auto` stops adding to the file so
    // it never mixes two blocks under one pin.
    if (file !== undefined && !sameBlock && file.entries.length > 0) {
        if (mode === "record") {
            warn(`forkit/http: re-recording "${options.name}" at ${runningAt}; replacing ${file.entries.length} response(s) recorded at ${recordedAt}.`);
        }
        else {
            const message = `forkit/http: fixture set "${options.name}" was recorded at ${recordedAt}, but this fork is at ${runningAt}. Replayed quotes may not match the fork's state; re-record with ${HTTP_MODE_ENV}=record. (${path})`;
            if (options.blockMismatch === "error")
                throw new ForkitError(message);
            warn(message);
        }
    }
    const recorded = new Map();
    if (file !== undefined && mode !== "record") {
        for (const entry of file.entries) {
            const key = keyOf(entry.request);
            const slot = recorded.get(key) ?? { responses: [], next: 0 };
            slot.responses.push(entry.response);
            recorded.set(key, slot);
        }
    }
    const canRecord = mode === "record" || (mode === "auto" && (file === undefined || sameBlock));
    const hosts = options.hosts === undefined ? undefined : new Set(options.hosts.map((h) => h.toLowerCase()));
    const intercepts = (url) => hosts === undefined
        ? !LOOPBACK.test(url.hostname)
        : hosts.has(url.host.toLowerCase()) || hosts.has(url.hostname.toLowerCase());
    const original = globalThis.fetch;
    const inflight = new Set();
    let intercepting = true;
    const note = (fixture, outcome) => emitForkitEvent({
        type: "http:request",
        ts: Date.now(),
        fixture: options.name,
        method: fixture.method,
        url: fixture.url,
        outcome,
    });
    async function forward(request, fixture, key) {
        const response = await original(request);
        if (!canRecord) {
            passthrough++;
            note(fixture, "passthrough");
            return response;
        }
        if (mode === "auto" && isTransient(response.status)) {
            passthrough++;
            note(fixture, "passthrough");
            warn(`forkit/http: not recording ${fixture.method} ${fixture.url}: HTTP ${response.status} is a transient or auth failure.`);
            return response;
        }
        const bytes = new Uint8Array(await response.clone().arrayBuffer());
        const entry = {
            request: fixture,
            response: {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders(response.headers, redactor),
                ...encodeBody(bytes, response.headers.get("content-type")),
            },
        };
        const list = session.get(key) ?? [];
        list.push(entry);
        session.set(key, list);
        note(fixture, "recorded");
        return response;
    }
    async function intercepted(request) {
        request.signal.throwIfAborted();
        const fixture = await toFixtureRequest(request, redactor);
        if (isJsonRpc(fixture.json))
            return original(request);
        const key = keyOf(fixture);
        if (mode !== "record") {
            const slot = recorded.get(key);
            if (slot !== undefined) {
                // Repeated requests replay in recorded order, then the last answer repeats.
                const response = slot.responses[Math.min(slot.next, slot.responses.length - 1)];
                slot.next++;
                if (response !== undefined) {
                    hits++;
                    note(fixture, "hit");
                    return toResponse(response, request.url);
                }
            }
            if (process.env.FORKIT_DEBUG) {
                console.error(`forkit/http miss: ${fixture.method} ${fixture.url}`);
            }
            // A miss `auto` records is expected; one that nothing records is worth reporting.
            if (mode === "replay" || !canRecord) {
                unmatched.push(`${fixture.method} ${fixture.url}`);
                note(fixture, "unmatched");
            }
            if (mode === "replay") {
                if (options.unmatched !== "passthrough") {
                    throw new HttpUnmatchedError(fixture.method, fixture.url, path, file !== undefined);
                }
                passthrough++;
                note(fixture, "passthrough");
                return original(request);
            }
        }
        return forward(request, fixture, key);
    }
    const patched = function fetch(input, init) {
        if (!intercepting)
            return original(input, init);
        let request;
        try {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (!intercepts(url))
                return original(input, init);
            request =
                input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        }
        catch {
            // Let the real fetch produce its own error for input it rejects.
            return original(input, init);
        }
        const pending = intercepted(request);
        inflight.add(pending);
        const done = () => {
            inflight.delete(pending);
        };
        pending.then(done, done);
        return pending;
    };
    // Keep static members (Bun's `fetch.preconnect`) available to code that uses them.
    Object.assign(patched, original);
    globalThis.fetch = patched;
    global[ACTIVE] = { name: options.name, path };
    return {
        name: options.name,
        mode,
        path,
        stats: () => ({
            name: options.name,
            path,
            mode,
            hits,
            recorded: recordedCount(),
            passthrough,
            unmatched: [...unmatched],
            entries: session.size === 0 ? (file?.entries.length ?? 0) : mergedEntries().length,
        }),
        stop() {
            stopped ??= (async () => {
                if (globalThis.fetch === patched) {
                    globalThis.fetch = original;
                }
                else {
                    warn(`forkit/http: globalThis.fetch was replaced while "${options.name}" was active (another mock?). Leaving it in place; forkit's layer now passes requests straight through.`);
                }
                intercepting = false;
                if (global[ACTIVE]?.path === path)
                    delete global[ACTIVE];
                await Promise.allSettled([...inflight]);
                if (session.size > 0)
                    writeMerged();
                if (unmatched.length > 0) {
                    warn(`forkit/http: ${unmatched.length} request(s) had no recording in ${path}:\n${unmatched.map((u) => `  ${u}`).join("\n")}`);
                }
            })();
            return stopped;
        },
    };
    /** Recordings on disk (re-read, to keep parallel writers' entries) merged with this run's. */
    function mergedEntries(onDisk = file) {
        const keep = onDisk !== undefined &&
            onDisk.blockNumber === blockNumber.toString() &&
            (onDisk.chainId === undefined ||
                options.chainId === undefined ||
                onDisk.chainId === options.chainId);
        const merged = (keep ? onDisk.entries : [])
            .map((entry) => ({ key: keyOf(entry.request), entry }))
            .filter(({ key }) => !session.has(key));
        for (const [key, list] of session)
            for (const entry of list)
                merged.push({ key, entry });
        return merged.sort(keySort).map(({ entry }) => entry);
    }
    function writeMerged() {
        const onDisk = readFixtureFile(path);
        const out = {
            version: 1,
            name: options.name,
            blockNumber: blockNumber.toString(),
            entries: mergedEntries(onDisk),
        };
        const chainId = options.chainId ?? (onDisk?.blockNumber === out.blockNumber ? onDisk.chainId : undefined);
        if (chainId !== undefined)
            out.chainId = chainId;
        writeFixtureFile(path, out);
    }
}
/** Record: every request goes to the network, and responses are saved at `blockNumber`. */
export function record(options) {
    return use({ ...options, mode: "record" });
}
/** Replay: serve the fixtures with no network. */
export function replay(options) {
    return use({ ...options, mode: "replay" });
}
/** Run `fn` with a fixture set active, and stop it afterwards whether `fn` throws or not. */
export async function withHttp(options, fn) {
    const fixtures = use(options);
    try {
        return await fn(fixtures);
    }
    finally {
        await fixtures.stop();
    }
}
//# sourceMappingURL=intercept.js.map