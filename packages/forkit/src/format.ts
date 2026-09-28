import { isAddress } from "viem";
import { formatAddress } from "./labels.ts";

const MAX_HEX = 66;

/** Render a decoded ABI value for humans: labels for addresses, bigints as decimals. */
export function formatValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (isAddress(value, { strict: false })) return formatAddress(value);
    if (/^0x[0-9a-fA-F]*$/.test(value)) {
      return value.length > MAX_HEX
        ? `${value.slice(0, MAX_HEX)}… (${(value.length - 2) / 2} bytes)`
        : value;
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${k}: ${formatValue(v)}`)
      .join(", ")} }`;
  }
  return String(value);
}

export function formatArgs(args: readonly unknown[] | undefined): string {
  return (args ?? []).map(formatValue).join(", ");
}

/** Deep equality for decoded ABI values: bigint-aware, addresses and hex case-insensitive. */
export function abiEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  if (typeof a === "number" && typeof b === "bigint") return BigInt(a) === b;
  if (typeof a === "bigint" && typeof b === "number") return a === BigInt(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => abiEqual(x, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        abiEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return Object.is(a, b);
}
