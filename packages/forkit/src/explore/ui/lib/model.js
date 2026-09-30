// The explorer's model: lookups, timelines, call-tree rows, the gas icicle, token flows, balance
// history, search and reproduction snippets, computed from a run record. Pure: no DOM, no
// network, so the unit tests import it directly.

import { shortHex } from "./format.js";

/** The pseudo-test that holds what ran outside any test (hooks). */
export const SETUP = "setup";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ---------------------------------------------------------------------------------------------
// Routes: `#/run/<id>/tx/<txid>?frame=0.1` — every view and selection has a URL.

export function route(parts, params) {
  const path = `#/${parts.map((p) => encodeURIComponent(p)).join("/")}`;
  const query = new URLSearchParams(
    Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  ).toString();
  return query === "" ? path : `${path}?${query}`;
}

export function parseHash(hash) {
  const raw = hash.replace(/^#\/?/, "");
  const at = raw.indexOf("?");
  const path = at === -1 ? raw : raw.slice(0, at);
  const params = new URLSearchParams(at === -1 ? "" : raw.slice(at + 1));
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  return { parts, params };
}

// ---------------------------------------------------------------------------------------------
// Index

const big = (v) => (v === undefined || v === null ? 0n : BigInt(v));

function groupBy(items, keyOf) {
  const out = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

/** Lookups every view shares. */
export function indexRun(run) {
  const cheats = run.cheats ?? [];
  const forks = new Map();
  for (const fork of run.forks) if (!forks.has(fork.chainId)) forks.set(fork.chainId, fork);
  const tests = new Map(run.tests.map((t) => [t.key, t]));
  const txs = new Map(run.txs.map((t) => [t.id, t]));
  const byTest = (items) => groupBy(items, (item) => item.test ?? SETUP);
  const findTx = (chainId, hash, test) => {
    if (typeof hash !== "string") return undefined;
    const lower = hash.toLowerCase();
    const matches = run.txs.filter((t) => t.chainId === chainId && t.hash?.toLowerCase() === lower);
    return matches.find((t) => t.test === test) ?? matches[0];
  };
  const fills = run.fills.map((fill) => ({
    fill,
    deposit: findTx(fill.originChainId, fill.depositTxHash, fill.test),
    fillTxs: fill.txHashes.map((hash) => ({
      hash,
      tx: findTx(fill.destinationChainId, hash, fill.test),
    })),
  }));
  const txFill = new Map();
  for (const linked of fills) {
    if (linked.deposit !== undefined) txFill.set(linked.deposit.id, { ...linked, role: "deposit" });
    for (const { tx } of linked.fillTxs)
      if (tx !== undefined) txFill.set(tx.id, { ...linked, role: "fill" });
  }
  const tokenByAddress = new Map();
  for (const [key, info] of Object.entries(run.tokens)) {
    const [chainId, address] = key.split(":");
    tokenByAddress.set(address, { chainId: Number(chainId), ...info });
  }
  return {
    run,
    cheats,
    forks,
    tests,
    txs,
    txsByTest: byTest(run.txs),
    dealsByTest: byTest(run.deals),
    fillsByTest: byTest(run.fills),
    httpByTest: byTest(run.http),
    gasByTest: byTest(run.gas),
    cheatsByTest: byTest(cheats),
    fills,
    txFill,
    tokenByAddress,
  };
}

export function chainName(idx, chainId) {
  return idx.forks.get(chainId)?.chainName ?? `Chain ${chainId}`;
}

export function labelOf(idx, address) {
  return typeof address === "string" ? idx.run.labels[address.toLowerCase()] : undefined;
}

/** A token's symbol and decimals (`native` is the chain's currency). */
export function tokenInfo(idx, chainId, token) {
  if (token === "native") {
    return { symbol: idx.forks.get(chainId)?.nativeSymbol ?? "ETH", decimals: 18 };
  }
  const info = idx.run.tokens[`${chainId}:${token}`] ?? idx.tokenByAddress.get(token) ?? {};
  return {
    symbol: info.symbol ?? labelOf(idx, token) ?? shortHex(token),
    decimals: info.decimals,
    name: info.name,
  };
}

/** Gas of mined transactions, and counts, for one test (or `SETUP`). */
export function testStats(idx, key) {
  const txs = idx.txsByTest.get(key) ?? [];
  let gas = 0n;
  for (const tx of txs) if (tx.gasUsed !== undefined && tx.mined) gas += big(tx.gasUsed);
  return { txs: txs.length, gas, reverts: txs.filter((t) => t.status === "reverted").length };
}

/** The run's headline numbers. */
export function runTotals(idx) {
  const { run } = idx;
  let gas = 0n;
  let fees = 0n;
  for (const tx of run.txs) {
    if (!tx.mined || tx.gasUsed === undefined) continue;
    gas += big(tx.gasUsed);
    if (tx.effectiveGasPrice !== undefined) fees += big(tx.gasUsed) * big(tx.effectiveGasPrice);
  }
  const blocks = new Set(
    run.txs.filter((t) => t.blockHash).map((t) => `${t.chainId}:${t.blockHash}`),
  );
  return {
    tests: run.tests.length,
    passed: run.tests.filter((t) => t.status === "pass").length,
    failed: run.tests.filter((t) => t.status === "fail").length,
    running: run.tests.filter((t) => t.status === "running").length,
    txs: run.txs.length,
    reverted: run.txs.filter((t) => t.status === "reverted").length,
    gas,
    fees,
    chains: new Set(run.forks.map((f) => f.chainId)).size,
    forks: run.forks.length,
    blocks: blocks.size,
    fills: run.fills.length,
    cheats: idx.cheats.length + run.deals.length,
    durationMs: run.updatedAt - run.startedAt,
  };
}

/** Tests with failures first, then in run order: what to read first after a red run. */
export function testsFailuresFirst(run) {
  const rank = (t) => (t.status === "fail" ? 0 : t.status === "running" ? 1 : 2);
  return run.tests
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t);
}

// ---------------------------------------------------------------------------------------------
// Timeline

/**
 * Every step of a test in order: transactions, deals, cheats (prank, warp, roll, snapshot,
 * revert), fills, HTTP replays, gas snapshots, and, for a failed test, the failed assertion
 * last. Transactions inside a prank carry `as` (the impersonated account).
 */
export function timeline(idx, key) {
  const test = idx.tests.get(key);
  const of = (map, kind) => (map.get(key) ?? []).map((value) => ({ kind, ts: value.ts, value }));
  const items = [
    ...of(idx.txsByTest, "tx"),
    ...of(idx.dealsByTest, "deal"),
    ...of(idx.cheatsByTest, "cheat"),
    ...of(idx.fillsByTest, "fill"),
    ...of(idx.httpByTest, "http"),
    ...of(idx.gasByTest, "gas"),
  ];
  // Stable: records with the same millisecond keep their kinds' natural order (a prank before
  // the transaction it wraps, its stop after).
  const order = { deal: 0, cheat: 1, tx: 2, gas: 3, fill: 4, http: 5 };
  items.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    const stopA = a.kind === "cheat" && a.value.cheat === "stopPrank";
    const stopB = b.kind === "cheat" && b.value.cheat === "stopPrank";
    if (stopA !== stopB) return stopA ? 1 : -1;
    return order[a.kind] - order[b.kind];
  });
  const pranks = new Map();
  for (const item of items) {
    if (item.kind === "cheat" && item.value.cheat === "prank") {
      const k = `${item.value.chainId}`;
      pranks.set(k, [...(pranks.get(k) ?? []), item.value.account]);
    } else if (item.kind === "cheat" && item.value.cheat === "stopPrank") {
      const k = `${item.value.chainId}`;
      pranks.set(k, (pranks.get(k) ?? []).slice(0, -1));
    } else if (item.kind === "tx") {
      const stack = pranks.get(`${item.value.chainId}`) ?? [];
      const as = stack[stack.length - 1];
      if (as !== undefined && as === item.value.from) item.as = as;
    }
  }
  if (test?.status === "fail") {
    items.push({
      kind: "assert",
      ts: test.startedAt + (test.durationMs ?? 0),
      value: test,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// Call trees

/** Every frame of a trace by its path (`0`, `0.1`, `0.1.0`). */
export function framesByPath(trace) {
  const out = new Map();
  const walk = (frame, path) => {
    out.set(path, frame);
    (frame.calls ?? []).forEach((child, i) => {
      walk(child, `${path}.${i}`);
    });
  };
  if (trace) walk(trace, "0");
  return out;
}

export function parentPath(path) {
  const at = path.lastIndexOf(".");
  return at === -1 ? undefined : path.slice(0, at);
}

/** Paths to open so that `path` shows: every ancestor. */
export function ancestors(path) {
  const out = [];
  for (let p = parentPath(path); p !== undefined; p = parentPath(p)) out.push(p);
  return out;
}

/**
 * The frames open by default: the first levels, and every frame on the way to a revert, so the
 * failure shows without a click.
 */
export function defaultOpen(trace, depth = 3) {
  const open = new Set();
  for (const [path, frame] of framesByPath(trace)) {
    const level = path.split(".").length - 1;
    if (level < depth) open.add(path);
    if (frame.error !== undefined) for (const a of ancestors(path)) open.add(a);
  }
  return open;
}

/** The deepest reverted frame: where a revert started. */
export function revertOrigin(trace) {
  let found;
  for (const [path, frame] of framesByPath(trace)) {
    if (frame.error === undefined) continue;
    if (found === undefined || path.startsWith(`${found.path}.`)) found = { path, frame };
  }
  return found;
}

/**
 * A trace as the rows of a collapsible tree: a row per visible frame, and a row per event at
 * its place among the frame's subcalls (`position`).
 */
export function traceRows(trace, open) {
  const rows = [];
  const walk = (frame, path, depth) => {
    const calls = frame.calls ?? [];
    const logs = frame.logs ?? [];
    const hasChildren = calls.length > 0 || logs.length > 0;
    const isOpen = hasChildren && open.has(path);
    rows.push({ type: "frame", path, depth, frame, hasChildren, open: isOpen });
    if (!isOpen) return;
    for (let i = 0; i <= calls.length; i++) {
      logs.forEach((log, j) => {
        if ((log.position ?? 0) === i || (i === calls.length && (log.position ?? 0) > i)) {
          rows.push({ type: "log", path: `${path}#${j}`, depth: depth + 1, log, frame });
        }
      });
      if (i < calls.length) walk(calls[i], `${path}.${i}`, depth + 1);
    }
  };
  if (trace) walk(trace, "0", 0);
  return rows;
}

/**
 * The gas icicle: one cell per frame, laid out by depth, each as wide as its share of the
 * transaction's gas, children left to right inside their parent.
 */
export function icicle(trace) {
  const cells = [];
  if (!trace) return { cells, depth: 0, total: 0n };
  const total = big(trace.gasUsed);
  let depth = 0;
  const walk = (frame, path, level, x0, width) => {
    depth = Math.max(depth, level + 1);
    cells.push({ path, depth: level, x0, x1: x0 + width, frame, gas: big(frame.gasUsed) });
    const own = big(frame.gasUsed);
    const children = frame.calls ?? [];
    const sum = children.reduce((s, c) => s + big(c.gasUsed), 0n);
    // Children can report more than the parent (gas forwarded, refunds): scale to fit.
    const scale = sum > own && sum > 0n ? Number(own) / Number(sum) : 1;
    let x = x0;
    children.forEach((child, i) => {
      const share = own > 0n ? (Number(big(child.gasUsed)) / Number(own)) * width * scale : 0;
      walk(child, `${path}.${i}`, level + 1, x, share);
      x += share;
    });
  };
  walk(trace, "0", 0, 0, total > 0n ? 1 : 0);
  return { cells, depth, total };
}

/** A frame's name as a trace line shows it: `transfer`, `receive`, `new`, or the selector. */
export function frameName(frame) {
  if (frame.type === "CREATE" || frame.type === "CREATE2") return "new";
  if (frame.call) return frame.call.name;
  if (!frame.input || frame.input === "0x") return "receive";
  return frame.input.slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Value moved

/**
 * Token and native transfers of a transaction, in order: ERC-20 `Transfer` events (from the
 * receipt), and native value moved by non-reverted CALLs in the trace.
 */
export function tokenTransfers(tx) {
  const out = [];
  const walk = (frame, path, reverted) => {
    const dead = reverted || frame.error !== undefined;
    const value = big(frame.value);
    if (
      !dead &&
      value > 0n &&
      frame.to &&
      frame.type !== "DELEGATECALL" &&
      frame.type !== "STATICCALL"
    ) {
      out.push({ token: "native", from: frame.from, to: frame.to, amount: value.toString(), path });
    }
    (frame.calls ?? []).forEach((c, i) => {
      walk(c, `${path}.${i}`, dead);
    });
  };
  if (tx.trace) walk(tx.trace, "0", false);
  else if (big(tx.value) > 0n && tx.to && tx.status !== "reverted") {
    out.push({ token: "native", from: tx.from, to: tx.to, amount: big(tx.value).toString() });
  }
  for (const log of tx.logs ?? []) {
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.data.length !== 66) continue;
    out.push({
      token: log.address,
      from: `0x${log.topics[1].slice(26)}`,
      to: `0x${log.topics[2].slice(26)}`,
      amount: BigInt(log.data).toString(),
      logIndex: log.logIndex,
    });
  }
  return out;
}

/** Balance changes with the balance before, when the balance after is known. */
export function balanceRows(tx) {
  return (tx.balanceChanges ?? []).map((c) => ({
    ...c,
    ...(c.after === undefined ? {} : { before: (big(c.after) - big(c.delta)).toString() }),
  }));
}

/** Net balance changes over transactions, per chain, holder and token. */
export function netChanges(txs) {
  const net = new Map();
  for (const tx of txs) {
    for (const change of tx.balanceChanges ?? []) {
      const key = `${tx.chainId}|${change.address}|${change.token}`;
      net.set(key, (net.get(key) ?? 0n) + big(change.delta));
    }
  }
  return [...net]
    .filter(([, delta]) => delta !== 0n)
    .map(([key, delta]) => {
      const [chainId, address, token] = key.split("|");
      return { chainId: Number(chainId), address, token, delta: delta.toString() };
    });
}

/**
 * What a bridge fill cost: the input the deposit locked minus the output the fill paid, in the
 * deposit's input token. From the fill's `details.fee` when the simulator gives it.
 */
export function bridgeFee(linked) {
  const { fill, deposit } = linked;
  const args = Object.fromEntries((deposit?.call?.args ?? []).map((a) => [a.name, a.value]));
  const input = args.inputAmount ?? args.amount;
  const output = fill.outputAmount ?? args.outputAmount;
  const detailsFee =
    fill.details && typeof fill.details === "object" ? fill.details.fee : undefined;
  let fee;
  if (typeof detailsFee === "string" || typeof detailsFee === "number") fee = String(detailsFee);
  else if (input !== undefined && output !== undefined) fee = (big(input) - big(output)).toString();
  const inputToken =
    typeof args.inputToken === "string" ? tokenFromWord(args.inputToken) : undefined;
  const outputToken =
    typeof args.outputToken === "string" ? tokenFromWord(args.outputToken) : undefined;
  return {
    ...(input === undefined ? {} : { input: String(input) }),
    ...(output === undefined ? {} : { output: String(output) }),
    ...(fee === undefined ? {} : { fee }),
    ...(inputToken === undefined ? {} : { inputToken }),
    ...(outputToken === undefined ? {} : { outputToken }),
  };
}

function tokenFromWord(value) {
  if (/^0x[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (/^0x0{24}[0-9a-f]{40}$/i.test(value)) return `0x${value.slice(26).toLowerCase()}`;
  return undefined;
}

/**
 * An address's balance of each token over the run: a point per deal (a balance set outright)
 * and per transaction that changed it (the balance after, when read).
 */
export function balanceSeries(idx, address) {
  const lower = address.toLowerCase();
  const series = new Map();
  const push = (chainId, token, point) => {
    const key = `${chainId}|${token}`;
    if (!series.has(key)) series.set(key, { chainId, token, points: [] });
    series.get(key).points.push(point);
  };
  for (const deal of idx.run.deals) {
    if (deal.holder === lower)
      push(deal.chainId, deal.token, { ts: deal.ts, test: deal.test, deal, value: deal.amount });
  }
  for (const tx of idx.run.txs) {
    for (const change of tx.balanceChanges ?? []) {
      if (change.address !== lower) continue;
      push(tx.chainId, change.token, {
        ts: tx.ts,
        test: tx.test,
        tx,
        change,
        ...(change.after === undefined ? {} : { value: change.after }),
      });
    }
  }
  return [...series.values()]
    .map((s) => ({ ...s, points: s.points.sort((a, b) => a.ts - b.ts) }))
    .sort((a, b) => a.chainId - b.chainId || a.token.localeCompare(b.token));
}

/** Transactions that touch an address: sent it, called it, created it, or moved its balance. */
export function addressTxs(idx, address) {
  const lower = address.toLowerCase();
  const touches = (frame) =>
    frame.from === lower || frame.to === lower || (frame.calls ?? []).some(touches);
  return idx.run.txs.filter(
    (tx) =>
      tx.from === lower ||
      tx.to === lower ||
      tx.contractAddress === lower ||
      (tx.balanceChanges ?? []).some((c) => c.address === lower) ||
      (tx.trace !== undefined && touches(tx.trace)),
  );
}

// ---------------------------------------------------------------------------------------------
// Search

/**
 * Search a run: a transaction hash, an address, a label, a token symbol, a test name or a
 * function name. Exact matches first, then prefixes, then substrings.
 */
export function search(idx, query, limit = 12) {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const { run } = idx;
  const results = [];
  const score = (text) => {
    const t = text.toLowerCase();
    if (t === q) return 0;
    if (t.startsWith(q)) return 1;
    return t.includes(q) ? 2 : -1;
  };
  const add = (kind, text, hit, entry) => {
    const s = score(hit);
    if (s >= 0) results.push({ kind, text, score: s, ...entry });
  };
  for (const test of run.tests) {
    add("test", test.name, test.name, { key: test.key, sub: test.suite, status: test.status });
  }
  const seen = new Set();
  for (const [address, name] of Object.entries(run.labels)) {
    seen.add(address);
    const best = [name, address].map(score).filter((s) => s >= 0);
    if (best.length > 0)
      results.push({
        kind: "address",
        text: name,
        sub: address,
        address,
        score: Math.min(...best),
      });
  }
  for (const [address, info] of idx.tokenByAddress) {
    if (seen.has(address) || !info.symbol) continue;
    seen.add(address);
    add("address", info.symbol, info.symbol, { sub: address, address });
  }
  for (const tx of run.txs) {
    const name = tx.call?.name ?? tx.functionName ?? tx.kind;
    if (tx.hash?.toLowerCase().startsWith(q) && q.length >= 4) {
      results.push({
        kind: "tx",
        text: name,
        sub: tx.hash,
        id: tx.id,
        score: q.length === 66 ? 0 : 1,
      });
    } else if (q.length >= 3 && name.toLowerCase().includes(q)) {
      add("tx", name, name, { sub: tx.hash ?? "not mined", id: tx.id, status: tx.status });
    }
    for (const a of [tx.from, tx.to, tx.contractAddress]) {
      if (!a || seen.has(a)) continue;
      if (q.length >= 4 && a.startsWith(q)) {
        seen.add(a);
        results.push({ kind: "address", text: shortHex(a, 10, 8), sub: a, address: a, score: 1 });
      }
    }
  }
  if (/^0x[0-9a-f]{40}$/.test(q) && !results.some((r) => r.address === q)) {
    results.push({ kind: "address", text: shortHex(q, 10, 8), sub: q, address: q, score: 0 });
  }
  const kindRank = { test: 0, tx: 1, address: 2 };
  return results
    .sort((a, b) => a.score - b.score || kindRank[a.kind] - kindRank[b.kind])
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Expected vs actual

/**
 * A character diff of two short strings: their common prefix and suffix, and what differs in
 * between, so `1,000,000,000` vs `999,890,778` highlights the digits that differ.
 */
export function diffStrings(expected, actual) {
  const a = String(expected);
  const b = String(actual);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const part = (s) => ({
    same0: s.slice(0, start),
    diff: s.slice(start, s.length - end),
    same1: s.slice(s.length - end),
  });
  return { expected: part(a), actual: part(b) };
}

/** Line diff for multi-line values (objects): each line marked same, removed or added. */
export function diffLines(expected, actual) {
  const a = String(expected).split("\n");
  const b = String(actual).split("\n");
  // Longest common subsequence; fine for the sizes an assertion prints.
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) {
    return [...a.map((text) => ({ op: "-", text })), ...b.map((text) => ({ op: "+", text }))];
  }
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Copy as code

const VIEM_CHAINS = {
  1: "mainnet",
  10: "optimism",
  56: "bsc",
  100: "gnosis",
  130: "unichain",
  137: "polygon",
  324: "zksync",
  480: "worldchain",
  8453: "base",
  31337: "foundry",
  42161: "arbitrum",
  43114: "avalanche",
  59144: "linea",
  81457: "blast",
  84532: "baseSepolia",
  421614: "arbitrumSepolia",
  11155111: "sepolia",
  11155420: "optimismSepolia",
};

const checksumless = (a) => `"${a}"`;
const bigintLiteral = (v) => `${BigInt(v).toString()}n`;

/** The viem chain export for a chain id, or a placeholder the reader fills in. */
function chainImport(chainId) {
  return VIEM_CHAINS[chainId];
}

/** `c.sendTransaction({ to, data, value })` for a recorded transaction (no semicolon). */
function txCall(tx) {
  const fields = [];
  if (tx.to) fields.push(`to: ${checksumless(tx.to)}`);
  if (tx.data && tx.data !== "0x") fields.push(`data: "${tx.data}"`);
  if (big(tx.value) > 0n) fields.push(`value: ${bigintLiteral(tx.value)}`);
  return `c.sendTransaction({ ${fields.join(", ")} })`;
}

/**
 * Code that reproduces a transaction.
 * - `viem`: the one transaction, sent as its sender on an anvil fork of the same block.
 * - `forkit`: an itFork test that replays the test's steps on that chain up to and including the
 *   transaction (deals, warps, rolls, and every transaction as its sender), so it starts from the
 *   same state.
 */
export function snippets(idx, tx) {
  const fork = idx.run.forks.find((f) => f.chainId === tx.chainId);
  const chain = chainImport(tx.chainId);
  const chainRef =
    chain ?? `defineChain({ id: ${tx.chainId} /* ${chainName(idx, tx.chainId)} */ })`;
  const chainImportLine = chain
    ? `import { ${chain} } from "viem/chains";`
    : `import { defineChain } from "viem";`;
  const block = fork?.blockNumber;
  const envVar = `FORKIT_RPC_URL_${tx.chainId}`;
  const from = tx.from ?? "0x0000000000000000000000000000000000000000";

  const viem = [
    `import { createTestClient, http, publicActions, walletActions } from "viem";`,
    chainImportLine,
    "",
    `// anvil --fork-url $${envVar}${block ? ` --fork-block-number ${block}` : ""}`,
    "// State at the fork block: earlier steps of the test (deals, other txs) are not replayed;",
    "// the forkit snippet replays them.",
    "const client = createTestClient({",
    `  chain: ${chainRef},`,
    `  mode: "anvil",`,
    `  transport: http("http://127.0.0.1:8545"),`,
    "})",
    "  .extend(publicActions)",
    "  .extend(walletActions);",
    "",
    `await client.impersonateAccount({ address: ${checksumless(from)} });`,
    `const hash = await client.sendTransaction({`,
    `  account: ${checksumless(from)},`,
    ...(tx.to ? [`  to: ${checksumless(tx.to)},`] : []),
    ...(tx.data && tx.data !== "0x" ? [`  data: "${tx.data}",`] : []),
    ...(big(tx.value) > 0n ? [`  value: ${bigintLiteral(tx.value)},`] : []),
    `});${tx.call ? ` // ${tx.call.signature}` : ""}`,
    "const receipt = await client.waitForTransactionReceipt({ hash });",
  ].join("\n");

  // The test's steps on this chain, up to and including this transaction.
  const key = tx.test ?? SETUP;
  const steps = [];
  for (const item of timeline(idx, key)) {
    if (item.kind === "assert") continue;
    const v = item.value;
    if (item.kind === "tx") {
      if (v.chainId !== tx.chainId) continue;
      const sender = v.from ?? from;
      const prank = `f.prank(${checksumless(sender)}, (c) => ${txCall(v)})`;
      const comment = v.call ? ` // ${v.call.signature}` : "";
      steps.push(
        v.status === "reverted" && v.id !== tx.id
          ? `    await expectRevert(${prank});${comment}`
          : `    await ${prank};${comment}`,
      );
      if (v.id === tx.id) break;
    } else if (item.kind === "deal" && v.chainId === tx.chainId) {
      steps.push(
        v.token === "native"
          ? `    await f.dealNative(${checksumless(v.holder)}, ${bigintLiteral(v.amount)});`
          : `    await f.deal(${checksumless(v.token)}, ${checksumless(v.holder)}, ${bigintLiteral(v.amount)});`,
      );
    } else if (item.kind === "cheat" && v.chainId === tx.chainId) {
      if (v.cheat === "warp") steps.push(`    await f.warp(${bigintLiteral(v.seconds ?? 0)});`);
      else if (v.cheat === "roll") steps.push(`    await f.roll(${bigintLiteral(v.blocks ?? 0)});`);
    }
  }
  const test = idx.tests.get(key);
  const usesRevert = steps.some((s) => s.includes("expectRevert"));
  const forkit = [
    ...(usesRevert ? [`import { expectRevert } from "@condensate/forkit";`] : []),
    `import { describeFork, itFork } from "@condensate/forkit/vitest";`,
    chainImportLine,
    "",
    `describeFork("replay", { chain: ${chainRef}${block ? `, blockNumber: ${bigintLiteral(block)}` : ""} }, (f) => {`,
    `  itFork(${JSON.stringify(`replays ${test ? test.name : "setup"} up to ${tx.call?.name ?? tx.kind}`)}, async () => {`,
    ...steps,
    "  });",
    "});",
  ].join("\n");
  return { viem, forkit };
}
