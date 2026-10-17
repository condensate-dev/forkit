/**
 * Convert a value to JSON: a bigint becomes its decimal string, `undefined` and functions are
 * dropped (in objects) or become `null` (in arrays), a `Uint8Array` becomes 0x hex, a `Date`
 * its epoch milliseconds, and a non-finite number `null`. Cycles become `"[circular]"`.
 */
export function toJson(value, seen = new Set()) {
    switch (typeof value) {
        case "bigint":
            return value.toString();
        case "string":
        case "boolean":
            return value;
        case "number":
            return Number.isFinite(value) ? value : null;
        case "undefined":
        case "function":
        case "symbol":
            return null;
    }
    if (value === null)
        return null;
    const object = value;
    if (seen.has(object))
        return "[circular]";
    if (object instanceof Date)
        return object.getTime();
    if (object instanceof Uint8Array) {
        return `0x${Array.from(object, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
    seen.add(object);
    try {
        if (Array.isArray(object))
            return object.map((item) => toJson(item, seen));
        if (object instanceof Map) {
            return Object.fromEntries([...object].map(([k, v]) => [String(k), toJson(v, seen)]));
        }
        const out = {};
        for (const [key, item] of Object.entries(object)) {
            if (item === undefined || typeof item === "function" || typeof item === "symbol")
                continue;
            out[key] = toJson(item, seen);
        }
        return out;
    }
    finally {
        seen.delete(object);
    }
}
/** `JSON.stringify` that refuses to guess: bigints and friends go through {@link toJson}. */
export function stringify(value, indent) {
    return JSON.stringify(toJson(value), null, indent);
}
//# sourceMappingURL=json.js.map