/**
 * Render run events as terminal text: fork boot lines, a per-test summary (txs, gas, signed balance
 * changes per labelled address and token), failure traces with an expected-vs-actual diff, bridge
 * simulator fills and a gas snapshot diff. Pure: the same events always give the same text.
 */
import { getAddress, type Hex, isAddress } from "viem";
import type {
  BridgeFillEvent,
  ForkBootEvent,
  ForkitEvent,
  GasSnapshotEvent,
  TestEndEvent,
  TestStartEvent,
  TxMinedEvent,
  TxRevertedEvent,
  TxSentEvent,
} from "../events.ts";
import { labelOf } from "../labels.ts";
import { type Palette, palette, shouldColor, stripAnsi } from "./ansi.ts";
import { TRANSFER_TOPIC, topicAddress } from "./collect.ts";
import { type RunLog, type TokenInfo, tokenKey } from "./serialize.ts";

export interface FormatOptions {
  /** ANSI colour. Default: {@link shouldColor} for stdout (off with `NO_COLOR`, in CI, off a TTY). */
  color?: boolean;
  /** A heading, e.g. the test file. */
  title?: string;
  /** Base for relative paths (the gas snapshot file). Default: `process.cwd()`. */
  cwd?: string;
  /**
   * Token symbols and decimals, by address (any chain) or `<chainId>:<address>`. They win over
   * what the run log read from the fork, e.g. when an offline fork cache cannot answer
   * `decimals()`.
   */
  tokens?: Readonly<Record<string, TokenInfo>>;
}

/** Everything a block renderer needs: colours, and names for addresses and tokens. */
export interface RenderContext {
  c: Palette;
  labels: Readonly<Record<string, string>>;
  tokens: Readonly<Record<string, TokenInfo>>;
  /** Chain names and native currency symbols, from `fork:boot` events. */
  chains: ReadonlyMap<number, { name: string; native: string }>;
  cwd: string;
}

const INDENT = "  ";
const DETAIL = "      ";
const NATIVE_DECIMALS = 18;

// ---------------------------------------------------------------------------------------------
// Numbers and names

/** `1234567n` → `1,234,567`. */
export function groupDigits(value: bigint | number): string {
  const text = (value < 0 ? -BigInt(value) : BigInt(value)).toString();
  return `${value < 0 ? "-" : ""}${text.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/**
 * A token amount for humans: grouped digits, `decimals` applied when known, at most 6 fraction
 * digits (more for a tiny amount, to show 4 significant ones), with `…` marking a cut. `signed`
 * adds `+` to positives.
 */
export function formatAmount(value: bigint, decimals?: number, signed = false): string {
  const sign = value < 0n ? "-" : signed && value > 0n ? "+" : "";
  const abs = value < 0n ? -value : value;
  if (decimals === undefined || decimals === 0) return `${sign}${groupDigits(abs)}`;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  let fraction = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  let cut = false;
  // Six decimals, or four significant digits for a small amount that has none in the first six.
  const keep = whole > 0n ? 6 : Math.max(6, (fraction.match(/^0*/)?.[0].length ?? 0) + 4);
  if (fraction.length > keep) {
    fraction = fraction.slice(0, keep).replace(/0+$/, "");
    cut = true;
  }
  return `${sign}${groupDigits(whole)}${fraction === "" ? "" : `.${fraction}`}${cut ? "…" : ""}`;
}

/** `0x1234…abcd`. */
export function shortHex(value: string): string {
  if (!value.startsWith("0x") || value.length <= 14) return value;
  const text = isAddress(value, { strict: false }) ? getAddress(value) : value;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function nameOf(ctx: RenderContext, address: string): string {
  const name = ctx.labels[address.toLowerCase()];
  if (name !== undefined) return name;
  // Transfers from and to the zero address are mints and burns.
  return /^0x0{40}$/i.test(address) ? "address(0)" : shortHex(address);
}

function durationOf(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function chainName(ctx: RenderContext, chainId: number): string {
  return ctx.chains.get(chainId)?.name ?? `chain ${chainId}`;
}

function relative(ctx: RenderContext, file: string): string {
  const base = ctx.cwd.endsWith("/") ? ctx.cwd : `${ctx.cwd}/`;
  return file.startsWith(base) ? file.slice(base.length) : file;
}

/** Pad to `width` columns, ignoring ANSI escapes. */
function pad(text: string, width: number, align: "left" | "right"): string {
  const fill = " ".repeat(Math.max(0, width - stripAnsi(text).length));
  return align === "left" ? `${text}${fill}` : `${fill}${text}`;
}

/** Aligned columns, two spaces apart. Cells may carry ANSI. */
function table(rows: readonly (readonly string[])[], align: readonly ("left" | "right")[]) {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => pad(cell, widths[i] ?? 0, align[i] ?? "left"))
      .join("  ")
      .trimEnd(),
  );
}

// ---------------------------------------------------------------------------------------------
// Fork boot line

type BootEvent = ForkBootEvent & { nativeSymbol?: string };

function cacheText(event: ForkBootEvent, c: Palette): string {
  const cache = event.cache;
  if (cache === undefined) return c.dim("no cache");
  const total = cache.hits + cache.misses;
  if (cache.misses === 0) {
    return c.green(`cache hit${total === 0 ? "" : ` (${groupDigits(cache.hits)} reads)`}`);
  }
  return c.yellow(`cache miss (${groupDigits(cache.misses)} of ${groupDigits(total)} upstream)`);
}

function hostOf(upstream: string): string {
  try {
    const url = new URL(upstream);
    return url.host;
  } catch {
    return upstream;
  }
}

/** `⛓ Base (8453) · block 21,000,000 · mainnet.base.org · cache hit (412 reads) · 812 ms`. */
export function formatBootLine(event: ForkBootEvent, ctx: RenderContext): string {
  const { c } = ctx;
  const block =
    event.blockNumber === undefined
      ? c.yellow("live head (unpinned)")
      : `block ${groupDigits(event.blockNumber)}`;
  return [
    `${c.cyan("⛓")} ${c.bold(`${event.chainName} (${event.chainId})`)}`,
    block,
    hostOf(event.upstream),
    cacheText(event, c),
    c.dim(`booted in ${durationOf(event.bootMs)}`),
  ].join(c.dim(" · "));
}

// ---------------------------------------------------------------------------------------------
// Per-test summary: txs, gas, balance changes

interface Activity {
  sent: TxSentEvent[];
  mined: TxMinedEvent[];
  reverted: TxRevertedEvent[];
  fills: BridgeFillEvent[];
}

const NATIVE = "native";

/**
 * Net balance changes from receipts: every ERC-20 `Transfer` log, plus each transaction's native
 * `value` and the gas its sender paid. Keys: address → token key (`<chainId>:<token>` or
 * `<chainId>:native`) → delta.
 */
export function balanceChanges(
  mined: readonly TxMinedEvent[],
  sent: readonly TxSentEvent[],
): Map<string, Map<string, bigint>> {
  const deltas = new Map<string, Map<string, bigint>>();
  const add = (holder: string | undefined, token: string, amount: bigint) => {
    if (holder === undefined || amount === 0n) return;
    const key = holder.toLowerCase();
    const row = deltas.get(key) ?? new Map<string, bigint>();
    row.set(token, (row.get(token) ?? 0n) + amount);
    deltas.set(key, row);
  };
  const values = new Map(sent.map((e) => [e.hash.toLowerCase(), e.value ?? 0n]));
  for (const tx of mined) {
    const native = tokenKey(tx.chainId, NATIVE);
    add(tx.from, native, -(tx.gasUsed * tx.effectiveGasPrice));
    if (tx.status !== "success") continue;
    const value = values.get(tx.hash.toLowerCase()) ?? 0n;
    add(tx.from, native, -value);
    add(tx.to ?? tx.contractAddress, native, value);
    for (const log of tx.logs) {
      if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
      let amount: bigint;
      try {
        amount = BigInt(log.data);
      } catch {
        continue;
      }
      const token = tokenKey(tx.chainId, log.address);
      add(topicAddress(log.topics[1]), token, -amount);
      add(topicAddress(log.topics[2]), token, amount);
    }
  }
  for (const [holder, row] of deltas) {
    for (const [token, amount] of row) if (amount === 0n) row.delete(token);
    if (row.size === 0) deltas.delete(holder);
  }
  return deltas;
}

function tokenMeta(ctx: RenderContext, key: string): { name: string; decimals?: number } {
  const [chain, address = ""] = key.split(":");
  const chainId = Number(chain);
  if (address === NATIVE) {
    return { name: ctx.chains.get(chainId)?.native ?? "ETH", decimals: NATIVE_DECIMALS };
  }
  const info = { ...ctx.tokens[key], ...ctx.tokens[address] };
  // Your label first, as in traces; then the token's own symbol.
  const name = ctx.labels[address] ?? info.symbol ?? shortHex(address);
  return info.decimals === undefined ? { name } : { name, decimals: info.decimals };
}

/** The balance table: one row per address, one column per token, signed and coloured deltas. */
export function formatBalanceTable(
  deltas: Map<string, Map<string, bigint>>,
  ctx: RenderContext,
): string[] {
  if (deltas.size === 0) return [];
  const { c } = ctx;
  const tokens: string[] = [];
  for (const row of deltas.values()) {
    for (const token of row.keys()) if (!tokens.includes(token)) tokens.push(token);
  }
  // ERC-20s in order of appearance, the native currency last.
  tokens.sort((a, b) => Number(a.endsWith(`:${NATIVE}`)) - Number(b.endsWith(`:${NATIVE}`)));
  const chains = new Set(tokens.map((t) => t.split(":")[0]));
  const header = [
    c.dim("balance change"),
    ...tokens.map((key) => {
      const { name } = tokenMeta(ctx, key);
      const chainId = Number(key.split(":")[0]);
      return c.dim(chains.size > 1 ? `${name} (${chainName(ctx, chainId)})` : name);
    }),
  ];
  const rows = [...deltas].map(([holder, row]) => [
    nameOf(ctx, holder),
    ...tokens.map((key) => {
      const amount = row.get(key);
      if (amount === undefined) return "";
      const text = formatAmount(amount, tokenMeta(ctx, key).decimals, true);
      return amount < 0n ? c.red(text) : c.green(text);
    }),
  ]);
  return table([header, ...rows], ["left", ...tokens.map(() => "right" as const)]);
}

// ---------------------------------------------------------------------------------------------
// Failure: message, trace, expected vs actual

const VIEM_NOISE =
  /^(Contract Call:|Request Arguments:|Raw Call Arguments:|Docs:|Version:|Estimate Gas Arguments:)/;
const MAX_MESSAGE_LINES = 8;

/** Split an error message into its head and the forkit trace it carries, if any. */
export function splitTrace(message: string): { head: string; trace?: string } {
  const match = /\n\n(?:Trace[^\n]*):\n/.exec(message);
  if (match === null) return { head: message };
  const lines = message
    .slice(match.index + match[0].length)
    .trimEnd()
    .split("\n");
  // forkit indents a trace it appends to a viem error by two spaces; undo that.
  const indented = lines.every((line) => line === "" || line.startsWith("  "));
  const trace = (indented ? lines.map((line) => line.slice(2)) : lines).join("\n");
  return { head: message.slice(0, match.index), trace };
}

function messageHead(message: string): string[] {
  const lines: string[] = [];
  for (const line of message.split("\n")) {
    if (VIEM_NOISE.test(line.trim())) break;
    lines.push(line);
  }
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  if (lines.length > MAX_MESSAGE_LINES) {
    return [...lines.slice(0, MAX_MESSAGE_LINES), `… (${lines.length - MAX_MESSAGE_LINES} more)`];
  }
  return lines;
}

/** Colour a Foundry-style trace: tree and gas dim, calls cyan, reverts red, returns green. */
export function colorTrace(trace: string, c: Palette): string[] {
  return trace.split("\n").map((line) => {
    const match = /^([\s│├└─]*)(\[\d+\] )?(.*)$/.exec(line);
    const [, tree = "", gas = "", rest = ""] = match ?? [];
    let body: string;
    if (rest.startsWith("← [Revert]")) body = c.red(rest);
    else if (rest.startsWith("← [Return]") || rest.startsWith("← [Stop]")) body = c.green(rest);
    else {
      body = rest.replace(
        /^(new )?([^\s:(]+)::([A-Za-z_$][\w$]*)/,
        (_m, created: string | undefined, target: string, fn: string) =>
          `${created ?? ""}${c.cyan(target)}::${c.bold(fn)}`,
      );
    }
    return `${c.dim(tree)}${gas === "" ? "" : `${c.dim(gas.trimEnd())} `}${body}`;
  });
}

/** Line diff of `expected` against `actual` (LCS), `-` for expected and `+` for actual. */
export function diffLines(
  expected: string,
  actual: string,
): { op: " " | "-" | "+"; line: string }[] {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        a[i] === b[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: { op: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: " ", line: a[i] as string });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j >= b.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))
    ) {
      // Deletions first, so a changed line reads "- old" then "+ new".
      out.push({ op: "-", line: a[i] as string });
      i++;
    } else {
      out.push({ op: "+", line: b[j] as string });
      j++;
    }
  }
  return out;
}

/** `- expected` / `+ actual` lines; a line diff when either side spans several lines. */
export function formatDiff(expected: string, actual: string, c: Palette): string[] {
  if (!expected.includes("\n") && !actual.includes("\n")) {
    return [
      c.dim("Expected vs actual:"),
      `${INDENT}${c.red(`- expected  ${expected}`)}`,
      `${INDENT}${c.green(`+ actual    ${actual}`)}`,
    ];
  }
  const lines = [c.dim("Expected (-) vs actual (+):")];
  for (const { op, line } of diffLines(expected, actual)) {
    const text = `${op} ${line}`;
    lines.push(`${INDENT}${op === "-" ? c.red(text) : op === "+" ? c.green(text) : c.dim(text)}`);
  }
  return lines;
}

/**
 * Why a test failed: the error's head, the Foundry-style trace of the revert behind it (from the
 * message, or from the `tx:reverted` event the error came from) and the expected-vs-actual diff.
 */
export function formatFailure(
  end: TestEndEvent,
  reverted: readonly TxRevertedEvent[],
  c: Palette,
): string[] {
  const lines: string[] = [];
  const message = end.error ?? "failed";
  const { head, trace: inMessage } = splitTrace(message);
  const firstLine = head.split("\n")[0] ?? "";
  const trace =
    inMessage ??
    [...reverted].reverse().find((e) => e.trace !== undefined && firstLine.startsWith(e.message))
      ?.trace;
  for (const [i, line] of messageHead(head).entries()) {
    lines.push(line.trim() === "" ? "" : c.red(`${i === 0 ? "✗" : " "} ${line.trimEnd()}`));
  }
  if (trace !== undefined) {
    lines.push(c.dim("Trace:"));
    for (const line of colorTrace(trace, c)) lines.push(`${INDENT}${line}`);
  }
  if (end.actual !== undefined && end.expected !== undefined) {
    lines.push(...formatDiff(end.expected, end.actual, c));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Bridge fills

/** The token delivered by a fill: a Transfer of `outputAmount` in one of the fill's receipts. */
function deliveredToken(fill: BridgeFillEvent, mined: readonly TxMinedEvent[]): string | undefined {
  const currency = fill.details?.currency;
  if (typeof currency === "string" && isAddress(currency, { strict: false })) {
    return /^0x0{40}$/i.test(currency)
      ? tokenKey(fill.destinationChainId, NATIVE)
      : tokenKey(fill.destinationChainId, currency);
  }
  if (fill.outputAmount === undefined) return undefined;
  const hashes = new Set(fill.txHashes.map((h) => h.toLowerCase()));
  for (const tx of mined) {
    if (!hashes.has(tx.hash.toLowerCase())) continue;
    for (const log of tx.logs) {
      if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
      try {
        if (BigInt(log.data) === fill.outputAmount) return tokenKey(tx.chainId, log.address);
      } catch {
        // Not an amount.
      }
    }
  }
  return undefined;
}

function shortDepositId(id: string): string {
  return id
    .split(":")
    .map((part) => (part.startsWith("0x") ? shortHex(part) : part))
    .join(":");
}

/** `⇄ across 8453:0x12ab…cd34:0 · Base → Arbitrum One · fill 0x… · fee 0.5 USDC · settled 999.5 USDC`. */
export function formatBridgeLine(
  fill: BridgeFillEvent,
  mined: readonly TxMinedEvent[],
  ctx: RenderContext,
): string {
  const { c } = ctx;
  const token = deliveredToken(fill, mined);
  const meta = token === undefined ? undefined : tokenMeta(ctx, token);
  const amount = (value: bigint) =>
    `${formatAmount(value, meta?.decimals)}${meta === undefined ? "" : ` ${meta.name}`}`;
  const [first, ...more] = fill.txHashes;
  const parts = [
    `${c.magenta("⇄")} ${c.bold(fill.bridge)} ${c.dim("deposit")} ${shortDepositId(fill.depositId)}`,
    `${chainName(ctx, fill.originChainId)} → ${chainName(ctx, fill.destinationChainId)}`,
    first === undefined
      ? c.dim("no fill tx")
      : `fill ${shortHex(first)}${more.length === 0 ? "" : c.dim(` (+${more.length} more)`)}`,
  ];
  const fee = fill.details?.fee;
  if (typeof fee === "bigint") parts.push(`fee ${amount(fee)}`);
  if (fill.outputAmount !== undefined) parts.push(c.green(`settled ${amount(fill.outputAmount)}`));
  return parts.join(c.dim(" · "));
}

// ---------------------------------------------------------------------------------------------
// Gas snapshot diff

/**
 * The gas table: per label, the committed value (the first measurement's `previous`) against the
 * latest measurement, with a coloured delta.
 */
export function formatGasTable(events: readonly GasSnapshotEvent[], ctx: RenderContext): string[] {
  if (events.length === 0) return [];
  const { c } = ctx;
  const byLabel = new Map<string, { before?: bigint; after: bigint }>();
  for (const event of events) {
    const seen = byLabel.get(event.label);
    if (seen === undefined) {
      byLabel.set(event.label, {
        ...(event.previous === undefined ? {} : { before: event.previous }),
        after: event.gas,
      });
    } else {
      seen.after = event.gas;
    }
  }
  const files = [...new Set(events.map((e) => relative(ctx, e.file)))];
  const modes = [...new Set(events.map((e) => e.mode))];
  const rows = [...byLabel]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, { before, after }]) => {
      if (before === undefined) {
        return [label, c.dim("—"), groupDigits(after), c.yellow("new"), ""];
      }
      const delta = after - before;
      const pct =
        before === 0n
          ? ""
          : `${delta > 0n ? "+" : ""}${((Number(delta) / Number(before)) * 100).toFixed(2)}%`;
      const paint = delta > 0n ? c.red : delta < 0n ? c.green : c.dim;
      return [
        label,
        groupDigits(before),
        groupDigits(after),
        paint(delta === 0n ? "0" : `${delta > 0n ? "+" : ""}${groupDigits(delta)}`),
        delta === 0n ? "" : paint(pct),
      ];
    });
  const heading = `${c.bold("gas snapshot")} ${c.dim(`· ${files.join(", ")} (${modes.join(", ")})`)}`;
  const header = ["label", "snapshot", "now", "Δ", ""].map((h) => c.dim(h));
  return [
    heading,
    ...table([header, ...rows], ["left", "right", "right", "right", "right"]).map(
      (line) => `${INDENT}${line}`,
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// The whole run

function emptyActivity(): Activity {
  return { sent: [], mined: [], reverted: [], fills: [] };
}

function record(activity: Activity, event: ForkitEvent): void {
  if (event.type === "tx:sent") activity.sent.push(event);
  else if (event.type === "tx:mined") activity.mined.push(event);
  else if (event.type === "tx:reverted") activity.reverted.push(event);
  else if (event.type === "bridge:fill") activity.fills.push(event);
}

function statsText(activity: Activity, c: Palette, durationMs?: number): string {
  const parts: string[] = [];
  const n = Math.max(activity.sent.length, activity.mined.length);
  if (n > 0) parts.push(`${n} tx${n === 1 ? "" : "s"}`);
  if (activity.reverted.length > 0) parts.push(`${activity.reverted.length} reverted`);
  if (activity.mined.length > 0) {
    parts.push(`${groupDigits(activity.mined.reduce((sum, tx) => sum + tx.gasUsed, 0n))} gas`);
  }
  if (durationMs !== undefined) parts.push(durationOf(durationMs));
  return c.dim(parts.join(" · "));
}

function activityLines(activity: Activity, ctx: RenderContext): string[] {
  const lines = formatBalanceTable(balanceChanges(activity.mined, activity.sent), ctx);
  for (const fill of activity.fills) lines.push(formatBridgeLine(fill, activity.mined, ctx));
  return lines;
}

/** One test: status, name, stats, balance table, bridge fills and, if it failed, why. */
export function formatTestBlock(
  start: TestStartEvent | undefined,
  end: TestEndEvent | undefined,
  activity: Activity,
  ctx: RenderContext,
): string[] {
  const { c } = ctx;
  const info = end ?? start;
  const name =
    info === undefined
      ? "(outside tests)"
      : info.suite === ""
        ? info.name
        : `${info.suite} › ${info.name}`;
  const glyph =
    end === undefined
      ? c.dim(info === undefined ? "·" : "?")
      : end.status === "pass"
        ? c.green("✓")
        : c.red("✗");
  const title = `${glyph} ${end?.status === "fail" ? c.red(name) : name}  ${statsText(activity, c, end?.durationMs)}`;
  const lines = [title];
  for (const line of activityLines(activity, ctx)) lines.push(`${DETAIL}${line}`);
  if (end?.status === "fail") {
    for (const line of formatFailure(end, activity.reverted, c)) lines.push(`${DETAIL}${line}`);
  }
  return lines;
}

function contextOf(log: RunLog, options: FormatOptions): RenderContext {
  const chains = new Map<number, { name: string; native: string }>();
  for (const event of log.events) {
    if (event.type === "fork:boot") {
      chains.set(event.chainId, {
        name: event.chainName,
        native: (event as BootEvent).nativeSymbol ?? "ETH",
      });
    }
  }
  const tokens: Record<string, TokenInfo> = { ...log.tokens };
  for (const [key, info] of Object.entries(options.tokens ?? {})) {
    tokens[key.toLowerCase()] = { ...tokens[key.toLowerCase()], ...info };
  }
  return {
    c: palette(options.color ?? shouldColor()),
    labels: { ...implicitLabels(log.events), ...log.labels },
    tokens,
    chains,
    cwd: options.cwd ?? process.cwd(),
  };
}

/** Names for unlabelled bridge actors: `across relayer`, `relay solver`. */
function implicitLabels(events: readonly ForkitEvent[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const event of events) {
    if (event.type !== "bridge:fill") continue;
    for (const role of ["relayer", "solver"] as const) {
      const address = event.details?.[role];
      if (typeof address === "string" && isAddress(address, { strict: false })) {
        labels[address.toLowerCase()] = `${event.bridge} ${role}`;
      }
    }
  }
  return labels;
}

/** Labels for the addresses in `events`, from this process's `label()` calls. */
function localLabels(events: readonly ForkitEvent[]): Record<string, string> {
  const labels: Record<string, string> = {};
  const visit = (value: unknown) => {
    if (typeof value === "string" && isAddress(value, { strict: false })) {
      const name = labelOf(value);
      if (name !== undefined) labels[value.toLowerCase()] = name;
    }
  };
  for (const event of events) {
    for (const value of Object.values(event)) visit(value);
    if (event.type === "tx:mined") {
      for (const log of event.logs) {
        visit(log.address);
        for (const topic of log.topics) visit(topicAddress(topic as Hex));
      }
    }
  }
  return labels;
}

/**
 * Render run events (or a run log from `collectRun().snapshot()`, which adds token symbols and
 * decimals) as text for a terminal or a CI log. Plain events are labelled with this process's
 * labels, and token amounts stay in raw units.
 */
export function formatRun(
  input: readonly ForkitEvent[] | RunLog,
  options: FormatOptions = {},
): string {
  const log: RunLog = Array.isArray(input)
    ? {
        events: [...(input as readonly ForkitEvent[])],
        labels: localLabels(input as readonly ForkitEvent[]),
        tokens: {},
      }
    : (input as RunLog);
  const ctx = contextOf(log, options);
  const { c } = ctx;
  const lines: string[] = [];
  if (options.title !== undefined) lines.push(`${c.bold("forkit")} ${c.dim("·")} ${options.title}`);
  const gas: GasSnapshotEvent[] = [];
  let outside = emptyActivity();
  let current: { start: TestStartEvent; activity: Activity } | undefined;
  const flushOutside = () => {
    if (outside.sent.length + outside.reverted.length + outside.fills.length === 0) return;
    const block = formatTestBlock(undefined, undefined, outside, ctx);
    // Outside a test there is no status; bridge fills alone read better as their own lines.
    if (outside.sent.length + outside.reverted.length === 0) {
      for (const fill of outside.fills)
        lines.push(`${INDENT}${formatBridgeLine(fill, outside.mined, ctx)}`);
    } else {
      for (const line of block) lines.push(`${INDENT}${line}`);
    }
    outside = emptyActivity();
  };
  for (const event of log.events) {
    switch (event.type) {
      case "fork:boot":
        if (current === undefined) flushOutside();
        lines.push(`${INDENT}${formatBootLine(event, ctx)}`);
        break;
      case "gas:snapshot":
        gas.push(event);
        break;
      case "test:start":
        flushOutside();
        current = { start: event, activity: emptyActivity() };
        break;
      case "test:end": {
        const start = current?.start.testId === event.testId ? current.start : undefined;
        const activity =
          start === undefined ? emptyActivity() : (current as { activity: Activity }).activity;
        for (const line of formatTestBlock(start, event, activity, ctx))
          lines.push(`${INDENT}${line}`);
        current = undefined;
        break;
      }
      default:
        record(current?.activity ?? outside, event);
    }
  }
  if (current !== undefined) {
    for (const line of formatTestBlock(current.start, undefined, current.activity, ctx)) {
      lines.push(`${INDENT}${line}`);
    }
  }
  flushOutside();
  if (gas.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...formatGasTable(gas, ctx));
  }
  return lines.map((line) => line.trimEnd()).join("\n");
}
