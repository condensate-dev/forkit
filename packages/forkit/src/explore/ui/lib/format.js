// Formatting for the explorer: pure functions, no DOM, so the unit tests can import them.

/** `0x1234…abcd`. */
export function shortHex(hex, head = 6, tail = 4) {
  if (typeof hex !== "string" || hex.length <= head + tail + 2) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function group3(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A decimal integer (string or bigint), with thousands separators. */
export function formatInt(value) {
  const text = String(value);
  return text.startsWith("-") ? `-${group3(text.slice(1))}` : group3(text);
}

/** `raw` (a decimal integer) scaled by `decimals`, at most `maxFraction` fraction digits. */
export function formatUnits(raw, decimals, maxFraction = 6) {
  let value = BigInt(raw);
  const negative = value < 0n;
  if (negative) value = -value;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  let fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  let approx = false;
  if (fraction.length > maxFraction) {
    fraction = fraction.slice(0, maxFraction).replace(/0+$/, "");
    approx = true;
  }
  const text = `${group3(whole.toString())}${fraction === "" ? "" : `.${fraction}`}`;
  const tiny = `<0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  return `${negative ? "-" : ""}${approx && text === "0" ? tiny : text}`;
}

/** 1,284 · 12.9K · 4.2M: gas and counts where space is short. */
export function compact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const abs = Math.abs(n);
  if (abs < 10_000) return formatInt(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(abs < 100_000 ? 1 : 0)}K`;
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(abs < 100_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

export function formatMs(ms) {
  if (ms === undefined || ms === null) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Seconds as a warp reads: `60 s`, `1 h`, `1 d 2 h`. */
export function formatSeconds(value) {
  let s = BigInt(value);
  if (s < 60n) return `${s} s`;
  const parts = [];
  for (const [unit, size] of [
    ["d", 86_400n],
    ["h", 3_600n],
    ["min", 60n],
    ["s", 1n],
  ]) {
    if (s >= size) {
      parts.push(`${s / size} ${unit}`);
      s %= size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

export function formatTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** A unix timestamp (seconds) as ISO, to the second. */
export function formatUnix(seconds) {
  return new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z");
}

export function formatOffset(ms) {
  if (ms < 0) return "";
  return ms < 1000 ? `+${Math.round(ms)}ms` : `+${(ms / 1000).toFixed(2)}s`;
}

export function percent(part, whole) {
  if (!whole) return "";
  const p = (Number(part) / Number(whole)) * 100;
  return p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
}

export function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}
