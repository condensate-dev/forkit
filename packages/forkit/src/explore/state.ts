/**
 * State diffs for the run record: the prestate tracer's diff mode (`{pre, post}`) as a list of
 * accounts with each changed balance, nonce, code and storage slot, before and after. Storage
 * slots get a best-effort name (`mapping(9)[alice]`) by hashing addresses the run knows.
 */
import { type Hex, keccak256, size } from "viem";
import type { AccountDiff, SlotDiff } from "./schema.ts";

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

const ZERO_WORD = `0x${"0".repeat(64)}`;
/** Mapping slots tried when naming storage: most contracts declare their mappings early. */
const MAX_MAPPING_SLOT = 16;
/** Keys tried for a nested mapping (`allowance[owner][spender]`), at most. */
const MAX_NESTED_KEYS = 24;

const word = (value: string | undefined): string =>
  value === undefined ? ZERO_WORD : `0x${value.slice(2).padStart(64, "0").toLowerCase()}`;

const codeSize = (code: Hex | undefined): number =>
  code === undefined || code === "0x" ? 0 : size(code);

const word32 = (hex: string): string => hex.slice(2).padStart(64, "0");

/** `keccak256(key . slot)`: where Solidity keeps `mapping[key]` of a mapping at `slot`. */
const mappingSlot = (key: string, slot: string): string =>
  keccak256(`0x${word32(key)}${word32(slot)}`);

const shortAddress = (address: string) => `0x${address.slice(2, 6)}…${address.slice(-4)}`;

/**
 * Names storage slots: `mapping(n)[key]` and `mapping(n)[key][key2]` for addresses it was told
 * about. Keys are added as a run goes on; names are looked up when a slot is named, so a label
 * given later still shows.
 */
export class SlotNamer {
  readonly #keys: string[] = [];
  readonly #names = new Map<string, string | undefined>();
  /** Slot to `[mapping slot, outer key, inner key?]`. */
  readonly #slots = new Map<string, [number, string, string?]>();
  /** How many keys have had their nested pairs hashed. */
  #nestedDone = 0;

  /** Know `address` (lowercase), shown as `name` (a label) or as a short address. */
  add(address: string, name?: string): void {
    const key = address.toLowerCase();
    if (this.#names.has(key)) {
      if (name !== undefined) this.#names.set(key, name);
      return;
    }
    this.#names.set(key, name);
    this.#keys.push(key);
    for (let n = 0; n < MAX_MAPPING_SLOT; n++) {
      this.#slots.set(mappingSlot(key, `0x${n.toString(16)}`), [n, key]);
    }
  }

  #show(address: string): string {
    return this.#names.get(address) ?? shortAddress(address);
  }

  name(slot: string): string | undefined {
    const lower = word(slot);
    let found = this.#slots.get(lower);
    if (found === undefined) {
      const small = BigInt(lower);
      if (small < 256n) return `slot ${small}`;
      this.#hashNested();
      found = this.#slots.get(lower);
    }
    if (found === undefined) return undefined;
    const [n, outer, inner] = found;
    return `mapping(${n})[${this.#show(outer)}]${inner === undefined ? "" : `[${this.#show(inner)}]`}`;
  }

  /** Nested mappings cost keys² × slots hashes: hashed only when a slot needs them, once. */
  #hashNested(): void {
    const keys = this.#keys.slice(0, MAX_NESTED_KEYS);
    for (let i = this.#nestedDone; i < keys.length; i++) {
      for (let j = 0; j <= i; j++) {
        const pairs: [string, string][] =
          i === j
            ? [[keys[i] as string, keys[i] as string]]
            : [
                [keys[i] as string, keys[j] as string],
                [keys[j] as string, keys[i] as string],
              ];
        for (const [outer, inner] of pairs) {
          for (let n = 0; n < MAX_MAPPING_SLOT; n++) {
            const outerSlot = mappingSlot(outer, `0x${n.toString(16)}`);
            this.#slots.set(mappingSlot(inner, outerSlot), [n, outer, inner]);
          }
        }
      }
    }
    this.#nestedDone = keys.length;
  }
}

/** The run record's view of a prestate diff: changed accounts, sorted by address. */
export function stateDiff(diff: PrestateDiff, namer?: SlotNamer): AccountDiff[] {
  const addresses = new Set([...Object.keys(diff.pre ?? {}), ...Object.keys(diff.post ?? {})]);
  const out: AccountDiff[] = [];
  for (const raw of [...addresses].sort()) {
    const pre = diff.pre?.[raw] ?? {};
    const post = diff.post?.[raw] ?? {};
    const account: AccountDiff = { address: raw.toLowerCase(), storage: [] };
    if (post.balance !== undefined) {
      const before = BigInt(pre.balance ?? "0x0");
      const after = BigInt(post.balance);
      if (before !== after)
        account.balance = { before: before.toString(), after: after.toString() };
    }
    if (post.nonce !== undefined && post.nonce !== (pre.nonce ?? 0)) {
      account.nonce = { before: pre.nonce ?? 0, after: post.nonce };
    }
    if (post.code !== undefined && post.code !== pre.code) {
      account.code = { before: codeSize(pre.code), after: codeSize(post.code) };
    }
    const slots = new Set([...Object.keys(pre.storage ?? {}), ...Object.keys(post.storage ?? {})]);
    for (const slot of [...slots].sort()) {
      const before = word(pre.storage?.[slot]);
      const after = word(post.storage?.[slot]);
      if (before === after) continue;
      const hint = namer?.name(slot);
      const diffed: SlotDiff = { slot: word(slot), before, after };
      if (hint !== undefined) diffed.hint = hint;
      account.storage.push(diffed);
    }
    if (account.balance || account.nonce || account.code || account.storage.length > 0) {
      out.push(account);
    }
  }
  return out;
}
