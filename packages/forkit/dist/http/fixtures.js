/**
 * The on-disk fixture format and request matching.
 *
 * One JSON file per named fixture set, pinned to the fork block it was recorded at. Keys are
 * sorted and bodies are stored as JSON when that is lossless, so a re-recording diffs cleanly.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ForkitError } from "../errors.js";
/** Response headers that describe the original transfer, not the content, or change every call. */
const DROPPED_RESPONSE_HEADERS = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "date",
    "keep-alive",
    "transfer-encoding",
    "age",
]);
const NAME_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
/** `<dir>/<name>.json`. Names may contain `/` for subdirectories, but not `..`. */
export function fixturePath(dir, name) {
    if (!NAME_PATTERN.test(name) || name.split("/").some((part) => part === ".." || part === ".")) {
        throw new ForkitError(`forkit/http: fixture name "${name}" must be letters, digits, ".", "_", "-" and "/" separators`);
    }
    const base = isAbsolute(dir) ? dir : resolve(dir);
    return join(base, `${name}.json`);
}
/**
 * JSON is stored parsed only when parsing loses nothing: an amount like `123456789012345678901`
 * would come back rounded, so such a body stays text.
 */
function losslessJson(text) {
    const trimmed = text.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("[")))
        return undefined;
    let lossy = false;
    let value;
    try {
        value = JSON.parse(text, function (_key, v, context) {
            if (typeof v === "number") {
                const source = context?.source ?? String(v);
                const digits = source
                    .replace(/^-/, "")
                    .replace(/e.*$/i, "")
                    .replace(/\./, "")
                    .replace(/^0+/, "");
                if ((Number.isInteger(v) && !Number.isSafeInteger(v)) || digits.length > 15)
                    lossy = true;
            }
            return v;
        });
    }
    catch {
        return undefined;
    }
    return lossy ? undefined : { value };
}
export function encodeBody(bytes, contentType) {
    if (bytes.byteLength === 0)
        return {};
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
        return { base64: Buffer.from(bytes).toString("base64") };
    }
    const json = contentType === null || /json|text\/plain/i.test(contentType) ? losslessJson(text) : undefined;
    return json === undefined ? { text } : { json: json.value };
}
export function decodeBody(body) {
    if ("json" in body)
        return JSON.stringify(body.json);
    if (body.text !== undefined)
        return body.text;
    if (body.base64 !== undefined)
        return Buffer.from(body.base64, "base64");
    return undefined;
}
export function responseHeaders(headers, redactor) {
    const out = {};
    for (const [name, value] of Object.entries(redactor.headers(headers))) {
        if (!DROPPED_RESPONSE_HEADERS.has(name))
            out[name] = value;
    }
    return out;
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object" && value !== null) {
        const keys = Object.keys(value).sort();
        const record = value;
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
function withoutPath(value, path) {
    const [head, ...rest] = path;
    if (head === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
        return value;
    }
    const copy = { ...value };
    if (rest.length === 0)
        delete copy[head];
    else if (head in copy)
        copy[head] = withoutPath(copy[head], rest);
    return copy;
}
/**
 * The matching key: method, URL (redacted, query sorted, ignored params dropped), the headers
 * named in `matchHeaders`, and the body (JSON canonicalised, ignored fields dropped). Built from
 * the stored form, so a recording and a live request are compared the same way.
 */
export function matchKey(request, redactor, match = {}) {
    const ignoredQuery = new Set((match.ignoreQuery ?? []).map((q) => q.toLowerCase()));
    let url = redactor.url(request.url);
    try {
        const parsed = new URL(url);
        const params = [...parsed.searchParams].filter(([name]) => !ignoredQuery.has(name.toLowerCase()));
        params.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
        parsed.search = new URLSearchParams(params).toString();
        parsed.hash = "";
        url = parsed.toString();
    }
    catch {
        // Not a URL fetch accepts; match it verbatim.
    }
    const headers = (match.matchHeaders ?? [])
        .map((h) => h.toLowerCase())
        .sort()
        .map((h) => `${h}: ${request.headers[h] ?? ""}`);
    let body = "";
    if ("json" in request) {
        let json = request.json;
        for (const path of match.ignoreBody ?? [])
            json = withoutPath(json, path.split("."));
        body = `json:${canonicalJson(json)}`;
    }
    else if (request.text !== undefined)
        body = `text:${request.text}`;
    else if (request.base64 !== undefined)
        body = `base64:${request.base64}`;
    return [`${request.method.toUpperCase()} ${url}`, ...headers, body].join("\n");
}
/** Read a fixture file; `undefined` when there is none. A corrupt file is an error, not a miss. */
export function readFixtureFile(path) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new ForkitError(`forkit/http: fixture file ${path} is not valid JSON`, { cause: error });
    }
    if (parsed.version !== 1 ||
        !Array.isArray(parsed.entries) ||
        typeof parsed.blockNumber !== "string") {
        throw new ForkitError(`forkit/http: ${path} is not a forkit HTTP fixture file (version 1). Delete it and record again.`);
    }
    return parsed;
}
function sortedRecord(record) {
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
/** Keys in sorted order. Bodies keep their own key order: they are served back as recorded. */
function sortedMessage(message) {
    const { json, text, base64, headers, ...rest } = message;
    const out = sortedRecord({ ...rest, headers: sortedRecord(headers) });
    if ("json" in message)
        out.json = json;
    if (text !== undefined)
        out.text = text;
    if (base64 !== undefined)
        out.base64 = base64;
    return sortedRecord(out);
}
/** Write atomically (tmp + rename), so a parallel reader never sees half a file. */
export function writeFixtureFile(path, file) {
    mkdirSync(dirname(path), { recursive: true });
    const body = sortedRecord({
        ...file,
        entries: file.entries.map((entry) => ({
            request: sortedMessage(entry.request),
            response: sortedMessage(entry.response),
        })),
    });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(tmp, path);
}
//# sourceMappingURL=fixtures.js.map