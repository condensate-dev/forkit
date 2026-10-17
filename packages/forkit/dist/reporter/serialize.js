export const tokenKey = (chainId, address) => `${chainId}:${address.toLowerCase()}`;
const BIGINT = "$bigint";
/** JSON for a run log, bigint-safe. */
export function serializeRunLog(log) {
    return JSON.stringify(log, (_key, value) => typeof value === "bigint" ? { [BIGINT]: value.toString() } : value);
}
/** The inverse of {@link serializeRunLog}. */
export function parseRunLog(text) {
    const parsed = JSON.parse(text, (_key, value) => {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            const keys = Object.keys(value);
            const raw = value[BIGINT];
            if (keys.length === 1 && typeof raw === "string")
                return BigInt(raw);
        }
        return value;
    });
    return { events: parsed.events ?? [], labels: parsed.labels ?? {}, tokens: parsed.tokens ?? {} };
}
/** Concatenate run logs in order; later labels and token metadata win. */
export function mergeRunLogs(logs) {
    const merged = { events: [], labels: {}, tokens: {} };
    for (const log of logs) {
        merged.events.push(...log.events);
        Object.assign(merged.labels, log.labels);
        Object.assign(merged.tokens, log.tokens);
    }
    return merged;
}
//# sourceMappingURL=serialize.js.map