/**
 * State diffs for the run record: the prestate tracer's diff mode (`{pre, post}`) as a list of
 * accounts with each changed balance, nonce, code and storage slot, before and after. Storage
 * slots get a best-effort name (`mapping(9)[alice]`) by hashing addresses the run knows.
 */
import { type Hex } from "viem";
import type { AccountDiff } from "./schema.ts";
/** One account in a prestate tracer result. */
export interface PrestateAccount {
    balance?: Hex;
    nonce?: number;
    code?: Hex;
    storage?: Record<string, Hex>;
}
/**
 * `prestateTracer` with `diffMode: true`: `pre` holds each changed account's state before the
 * transaction, `post` only the fields that changed. A slot cleared to zero is in `pre` only; a
 * slot written from zero is in `post` only; a slot only read is in neither.
 */
export interface PrestateDiff {
    pre: Record<string, PrestateAccount>;
    post: Record<string, PrestateAccount>;
}
/**
 * Names storage slots: `mapping(n)[key]` and `mapping(n)[key][key2]` for addresses it was told
 * about. Keys are added as a run goes on; names are looked up when a slot is named, so a label
 * given later still shows.
 */
export declare class SlotNamer {
    #private;
    /** Know `address` (lowercase), shown as `name` (a label) or as a short address. */
    add(address: string, name?: string): void;
    name(slot: string): string | undefined;
}
/** The run record's view of a prestate diff: changed accounts, sorted by address. */
export declare function stateDiff(diff: PrestateDiff, namer?: SlotNamer): AccountDiff[];
//# sourceMappingURL=state.d.ts.map