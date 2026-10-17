/**
 * Explicit JSON conversion for run records. `JSON.stringify` throws on a bigint, and silently
 * turns other non-JSON values into `{}` or drops them; run records convert every value on purpose.
 */
import type { Json } from "./schema.ts";
/**
 * Convert a value to JSON: a bigint becomes its decimal string, `undefined` and functions are
 * dropped (in objects) or become `null` (in arrays), a `Uint8Array` becomes 0x hex, a `Date`
 * its epoch milliseconds, and a non-finite number `null`. Cycles become `"[circular]"`.
 */
export declare function toJson(value: unknown, seen?: Set<object>): Json;
/** `JSON.stringify` that refuses to guess: bigints and friends go through {@link toJson}. */
export declare function stringify(value: unknown, indent?: number): string;
//# sourceMappingURL=json.d.ts.map