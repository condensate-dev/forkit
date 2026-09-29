// forkit explore: a read-only explorer over forkit run records. Plain DOM, no framework, no
// network beyond this server's /api. Every string from a run record goes in as text, never HTML.

const app = document.getElementById("app");
const crumbs = document.getElementById("crumbs");
const searchForm = document.getElementById("search");
const searchInput = document.getElementById("search-input");

const SETUP = "setup";
const runCache = new Map();
let runList;
let current;

// ---------------------------------------------------------------------------------------------
// DOM helpers

/** Build an element. `attrs` values: strings, booleans, or event handlers (`on*`). */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else if (key === "class") {
      el.className = value;
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function link(href, ...children) {
  return h("a", { href }, ...children);
}

function panel(title, count, ...body) {
  return h(
    "section",
    { class: "panel" },
    h(
      "div",
      { class: "panel-head" },
      h("h2", null, title, count === undefined ? null : h("span", { class: "count" }, ` ${count}`)),
    ),
    ...body,
  );
}

function table(headers, rows, options = {}) {
  const head = h(
    "tr",
    null,
    headers.map((header) =>
      h(
        "th",
        {
          class: [header.num ? "num" : "", header.hideSm ? "hide-sm" : ""].join(" ").trim() || null,
        },
        header.label,
      ),
    ),
  );
  const body = rows.map((row) => {
    if (row.group !== undefined) {
      return h("tr", { class: "group" }, h("td", { colspan: headers.length }, row.group));
    }
    return h(
      "tr",
      null,
      row.cells.map((cell, i) => {
        const header = headers[i];
        const cls = [
          header.num ? "num" : "",
          header.hideSm ? "hide-sm" : "",
          header.name ? "name-cell" : "",
          header.full ? "full" : "",
        ]
          .join(" ")
          .trim();
        return h("td", { class: cls || null, "data-label": header.label }, cell);
      }),
    );
  });
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: options.cards ? "table-cards" : null },
      h("thead", null, head),
      h("tbody", null, body),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Formatting

const route = (...parts) => `#/${parts.map((p) => encodeURIComponent(p)).join("/")}`;

function shortHex(hex, head = 6, tail = 4) {
  if (typeof hex !== "string" || hex.length <= head + tail + 2) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function group3(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A decimal integer string, with thousands separators. */
function formatInt(value) {
  const text = String(value);
  return text.startsWith("-") ? `-${group3(text.slice(1))}` : group3(text);
}

/** `raw` (a decimal integer string) scaled by `decimals`, at most `maxFraction` fraction digits. */
function formatUnits(raw, decimals, maxFraction = 6) {
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
  return `${negative ? "-" : ""}${approx && text === "0" ? "<0.000001" : text}`;
}

function formatMs(ms) {
  if (ms === undefined) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatOffset(ms) {
  if (ms < 0) return "";
  return ms < 1000 ? `+${Math.round(ms)}ms` : `+${(ms / 1000).toFixed(2)}s`;
}

function statusPill(status) {
  if (status === "pass") return h("span", { class: "pill ok" }, "passed");
  if (status === "fail") return h("span", { class: "pill bad" }, "failed");
  if (status === "success") return h("span", { class: "pill ok" }, "success");
  if (status === "reverted") return h("span", { class: "pill bad" }, "reverted");
  if (status === "running") return h("span", { class: "pill warn" }, "running");
  return h("span", { class: "pill" }, status);
}

function statusDot(status) {
  const cls =
    status === "pass" || status === "success"
      ? "ok"
      : status === "fail" || status === "reverted"
        ? "bad"
        : "warn";
  return h("span", { class: `dot ${cls}`, title: status });
}

// ---------------------------------------------------------------------------------------------
// Run index: lookups the views share

function indexRun(run) {
  const forks = new Map();
  for (const fork of run.forks) if (!forks.has(fork.chainId)) forks.set(fork.chainId, fork);
  const tests = new Map(run.tests.map((t) => [t.key, t]));
  const txs = new Map(run.txs.map((t) => [t.id, t]));
  const byTest = (items) => {
    const out = new Map();
    for (const item of items) {
      const key = item.test ?? SETUP;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(item);
    }
    return out;
  };
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
  return {
    run,
    forks,
    tests,
    txs,
    txsByTest: byTest(run.txs),
    dealsByTest: byTest(run.deals),
    fillsByTest: byTest(run.fills),
    httpByTest: byTest(run.http),
    gasByTest: byTest(run.gas),
    fills,
    txFill,
  };
}

function chainName(idx, chainId) {
  return idx.forks.get(chainId)?.chainName ?? `Chain ${chainId}`;
}

function chainChip(idx, chainId) {
  return h("span", { class: "chip", title: `chain id ${chainId}` }, chainName(idx, chainId));
}

function labelOf(idx, address) {
  return typeof address === "string" ? idx.run.labels[address.toLowerCase()] : undefined;
}

/** An address, labelled when the run knows it, linking to its address view. */
function addr(idx, address, options = {}) {
  if (typeof address !== "string") return h("span", { class: "faint" }, "—");
  const lower = address.toLowerCase();
  const name = labelOf(idx, lower);
  const text = options.full ? address : shortHex(address);
  return h(
    "a",
    { class: "addr", href: route("run", idx.run.id, "address", lower), title: address },
    name === undefined
      ? text
      : [
          h("span", { class: "lbl" }, name),
          options.full ? h("span", { class: "faint" }, ` ${text}`) : null,
        ],
  );
}

function tokenInfo(idx, chainId, token) {
  if (token === "native") {
    return { symbol: idx.forks.get(chainId)?.nativeSymbol ?? "ETH", decimals: 18 };
  }
  const info = idx.run.tokens[`${chainId}:${token}`] ?? {};
  return {
    symbol: info.symbol ?? labelOf(idx, token) ?? shortHex(token),
    decimals: info.decimals,
  };
}

/** A token amount: scaled and with its symbol when the decimals are known. */
function amount(idx, chainId, token, raw, options = {}) {
  const info = tokenInfo(idx, chainId, token);
  const value = BigInt(raw);
  const text = info.decimals === undefined ? formatInt(raw) : formatUnits(raw, info.decimals);
  const signed = options.signed && value > 0n ? `+${text}` : text;
  const cls = options.signed ? (value > 0n ? "pos" : value < 0n ? "neg" : "") : "";
  const symbol =
    token === "native"
      ? info.symbol
      : h("a", { href: route("run", idx.run.id, "address", token), title: token }, info.symbol);
  return h("span", { class: `amount ${cls}`.trim(), title: `${raw} (raw)` }, signed, " ", symbol);
}

function txLink(idx, tx, text) {
  return link(
    route("run", idx.run.id, "tx", tx.id),
    text ?? (tx.hash ? shortHex(tx.hash, 10, 6) : "not mined"),
  );
}

function testLink(idx, key) {
  if (key === undefined || key === SETUP)
    return link(route("run", idx.run.id, "test", SETUP), "setup & teardown");
  const test = idx.tests.get(key);
  return link(route("run", idx.run.id, "test", key), test ? test.name : key);
}

// ---------------------------------------------------------------------------------------------
// Decoded values

function isPaddedAddress(hex) {
  return /^0x0{24}[0-9a-f]{40}$/i.test(hex) && !/^0x0{64}$/i.test(hex);
}

/** One decoded ABI value, rendered by its Solidity type. */
function value(idx, type, v) {
  const array = /^(.*)\[(\d*)\]$/.exec(type);
  if (array !== null && Array.isArray(v)) {
    if (v.length === 0) return h("span", { class: "faint" }, "[]");
    return h(
      "span",
      null,
      "[",
      v.map((item, i) => [i > 0 ? ", " : null, value(idx, array[1], item)]),
      "]",
    );
  }
  if (type === "tuple" && Array.isArray(v)) {
    return h(
      "div",
      { class: "tuple" },
      v.map((p, i) => [
        h("span", { class: "k" }, p.name || String(i)),
        h("span", null, value(idx, p.type, p.value)),
      ]),
    );
  }
  if (type === "address") return addr(idx, v);
  if (type === "bool") return String(v);
  if (/^u?int\d*$/.test(type)) return h("span", { class: "mono", title: String(v) }, formatInt(v));
  if (type === "bytes32" && typeof v === "string" && isPaddedAddress(v)) {
    return h(
      "span",
      { title: v },
      addr(idx, `0x${v.slice(26)}`),
      h("span", { class: "faint" }, " (bytes32)"),
    );
  }
  if (type.startsWith("bytes") && typeof v === "string") {
    return h(
      "span",
      { class: "mono", title: v },
      v.length > 74 ? `${v.slice(0, 66)}… (${(v.length - 2) / 2} bytes)` : v,
    );
  }
  if (type === "string") return h("span", { class: "mono" }, JSON.stringify(v));
  return h("span", { class: "mono" }, typeof v === "string" ? v : JSON.stringify(v));
}

/** `name(arg, arg)` inline, for timelines and trace lines. */
function inlineCall(idx, call, target) {
  const args = call.args.map((arg, i) => [
    i > 0 ? ", " : null,
    arg.name ? h("span", { class: "arg-name" }, `${arg.name}: `) : null,
    arg.type === "tuple" ? h("span", { class: "faint" }, "{…}") : value(idx, arg.type, arg.value),
  ]);
  return h(
    "span",
    { class: "call" },
    target ?? null,
    target ? "." : null,
    h("span", { class: "fn" }, call.name),
    "(",
    args,
    ")",
  );
}

function paramsTable(idx, params) {
  return h(
    "table",
    { class: "params" },
    h(
      "tbody",
      null,
      params.map((p, i) =>
        h(
          "tr",
          null,
          h(
            "td",
            null,
            h("span", { class: "mono" }, p.name || `[${i}]`),
            h("div", { class: "ty" }, p.type),
          ),
          h("td", null, value(idx, p.type, p.value)),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Data

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = (await response.json()).error ?? message;
    } catch {
      // Keep the status.
    }
    throw new Error(message);
  }
  return await response.json();
}

async function loadRun(id) {
  if (!runCache.has(id))
    runCache.set(id, getJson(`/api/runs/${encodeURIComponent(id)}`).then(indexRun));
  try {
    return await runCache.get(id);
  } catch (error) {
    runCache.delete(id);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Views

function setCrumbs(...items) {
  crumbs.replaceChildren();
  items.forEach((item, i) => {
    if (i > 0) crumbs.append(h("span", { class: "sep" }, "/"));
    crumbs.append(
      item.href ? link(item.href, item.text) : h("span", { title: item.text }, item.text),
    );
  });
}

function runCrumbs(idx, ...more) {
  return [
    { text: "Runs", href: "#/" },
    { text: idx.run.id, href: route("run", idx.run.id) },
    ...more,
  ];
}

function stat(label, v) {
  return h(
    "div",
    { class: "stat" },
    h("span", { class: "k" }, label),
    h("span", { class: "v" }, v),
  );
}

function viewRuns(runs) {
  setCrumbs({ text: "Runs" });
  const rows = runs.map((r) => ({
    cells: [
      h(
        "div",
        null,
        link(route("run", r.id), h("span", { class: "mono" }, r.id)),
        h("div", { class: "faint" }, formatTime(r.startedAt)),
      ),
      h(
        "span",
        null,
        r.failed > 0
          ? h("span", { class: "pill bad" }, `${r.failed} failed`)
          : h("span", { class: "pill ok" }, "all passed"),
      ),
      formatInt(r.tests),
      formatInt(r.txs),
      formatInt(r.fills),
      h(
        "span",
        null,
        r.chains.map((c, i) => [i > 0 ? " " : null, h("span", { class: "chip" }, c.chainName)]),
      ),
      formatMs(r.updatedAt - r.startedAt),
    ],
  }));
  return [
    h(
      "div",
      { class: "page-head" },
      h("h1", null, "Runs"),
      h("span", { class: "sub" }, `${runs.length} recorded`),
    ),
    runs.length === 0
      ? h(
          "div",
          { class: "callout" },
          h("h2", null, "No runs recorded yet"),
          h(
            "p",
            { class: "muted" },
            "Record one with ",
            h("code", null, "FORKIT_RECORD=1"),
            " in front of your test command, then reload.",
          ),
        )
      : h(
          "section",
          { class: "panel" },
          table(
            [
              { label: "Run", name: true },
              { label: "Result" },
              { label: "Tests", num: true },
              { label: "Txs", num: true },
              { label: "Fills", num: true, hideSm: true },
              { label: "Chains", hideSm: true },
              { label: "Duration", num: true },
            ],
            rows,
            { cards: true },
          ),
        ),
  ];
}

function testStats(idx, key) {
  const txs = idx.txsByTest.get(key) ?? [];
  let gas = 0n;
  for (const tx of txs) if (tx.gasUsed !== undefined && tx.mined) gas += BigInt(tx.gasUsed);
  return { txs: txs.length, gas, reverts: txs.filter((t) => t.status === "reverted").length };
}

/** The amount a fill delivered, in its token when a fill transaction shows which token. */
function fillOutput(idx, linked) {
  const { fill, fillTxs } = linked;
  if (fill.outputAmount === undefined) return null;
  const token = fillTxs
    .map(
      ({ tx }) =>
        tx?.balanceChanges.find((c) => c.token !== "native" && c.delta === fill.outputAmount)
          ?.token,
    )
    .find((t) => t !== undefined);
  return token === undefined
    ? h("span", { class: "mono" }, formatInt(fill.outputAmount))
    : amount(idx, fill.destinationChainId, token, fill.outputAmount);
}

function fillRoute(idx, linked) {
  const { fill, deposit, fillTxs } = linked;
  const leg = (chainId, title, body) =>
    h(
      "div",
      { class: "leg" },
      h("div", { class: "head" }, h("strong", null, title), chainChip(idx, chainId)),
      body,
    );
  const output = fillOutput(idx, linked);
  return h(
    "div",
    { class: "route" },
    leg(
      fill.originChainId,
      "Deposit",
      h(
        "div",
        null,
        deposit
          ? txLink(idx, deposit)
          : h("span", { class: "hash" }, shortHex(fill.depositTxHash, 10, 6)),
        deposit?.call ? h("span", { class: "faint" }, ` ${deposit.call.name}`) : null,
      ),
    ),
    h("div", { class: "arrow", "aria-hidden": "true" }, "→"),
    leg(
      fill.destinationChainId,
      "Fill",
      fillTxs.length === 0
        ? h("span", { class: "faint" }, "no transaction")
        : fillTxs.map(({ hash, tx }) =>
            h(
              "div",
              null,
              tx ? txLink(idx, tx) : h("span", { class: "hash" }, shortHex(hash, 10, 6)),
              tx?.call ? h("span", { class: "faint" }, ` ${tx.call.name}`) : null,
            ),
          ),
    ),
    h(
      "div",
      { class: "foot" },
      h("span", { class: "chip", title: `deposit ${fill.depositId}` }, fill.bridge),
      output ? [" delivered ", output] : null,
      fill.test ? [" · in ", testLink(idx, fill.test)] : null,
    ),
  );
}

function viewRun(idx) {
  const { run } = idx;
  setCrumbs(...runCrumbs(idx).slice(0, 1), { text: run.id });
  const passed = run.tests.filter((t) => t.status === "pass").length;
  const failed = run.tests.filter((t) => t.status === "fail").length;

  // Tests, grouped by suite in run order.
  const suites = new Map();
  for (const test of run.tests) {
    if (!suites.has(test.suite)) suites.set(test.suite, []);
    suites.get(test.suite).push(test);
  }
  const rows = [];
  for (const [suite, tests] of suites) {
    rows.push({ group: suite });
    for (const test of tests) {
      const s = testStats(idx, test.key);
      rows.push({
        cells: [
          h(
            "span",
            null,
            statusDot(test.status),
            " ",
            link(route("run", run.id, "test", test.key), test.name),
          ),
          formatInt(s.txs),
          s.gas > 0n ? formatInt(s.gas.toString()) : h("span", { class: "faint" }, "—"),
          s.reverts > 0
            ? h("span", { class: "neg" }, String(s.reverts))
            : h("span", { class: "faint" }, "0"),
          formatMs(test.durationMs),
        ],
      });
    }
  }
  const setup = testStats(idx, SETUP);
  const setupDeals = (idx.dealsByTest.get(SETUP) ?? []).length;
  if (setup.txs > 0 || setupDeals > 0) {
    rows.push({ group: "Outside tests" });
    rows.push({
      cells: [
        h("span", null, h("span", { class: "dot" }), " ", testLink(idx, SETUP)),
        formatInt(setup.txs),
        setup.gas > 0n ? formatInt(setup.gas.toString()) : h("span", { class: "faint" }, "—"),
        setup.reverts > 0
          ? h("span", { class: "neg" }, String(setup.reverts))
          : h("span", { class: "faint" }, "0"),
        "",
      ],
    });
  }

  const forkRows = run.forks.map((f) => ({
    cells: [
      h(
        "span",
        null,
        h("strong", null, f.chainName),
        h("span", { class: "faint" }, ` ${f.chainId}`),
      ),
      f.blockNumber === undefined
        ? h("span", { class: "pill warn" }, "live head")
        : h("span", { class: "mono" }, formatInt(f.blockNumber)),
      f.cache
        ? h(
            "span",
            { title: `${f.cache.mode}: ${f.cache.hits} hits, ${f.cache.misses} misses` },
            `${f.cache.hits}/${f.cache.hits + f.cache.misses}`,
          )
        : h("span", { class: "faint" }, "off"),
      formatMs(f.bootMs),
    ],
  }));

  const labelled = Object.entries(run.labels).sort((a, b) => a[1].localeCompare(b[1]));
  const gasRows = run.gas.map((g) => {
    const delta = g.previous === undefined ? undefined : BigInt(g.gas) - BigInt(g.previous);
    return {
      cells: [
        h("span", { class: "mono" }, g.label),
        formatInt(g.gas),
        delta === undefined
          ? h("span", { class: "faint" }, "new")
          : h(
              "span",
              { class: delta > 0n ? "neg" : delta < 0n ? "pos" : "faint" },
              delta > 0n ? `+${formatInt(delta.toString())}` : formatInt(delta.toString()),
            ),
      ],
    };
  });

  const side = [
    panel(
      "Forks",
      run.forks.length,
      run.forks.length === 0
        ? h("div", { class: "empty" }, "No forks booted.")
        : table(
            [
              { label: "Chain" },
              { label: "Block", num: true },
              { label: "Cache", num: true },
              { label: "Boot", num: true },
            ],
            forkRows,
          ),
    ),
    panel(
      "Cross-chain fills",
      run.fills.length,
      idx.fills.length === 0
        ? h("div", { class: "empty" }, "No bridge fills in this run.")
        : idx.fills.map((linked) => fillRoute(idx, linked)),
    ),
    labelled.length === 0
      ? null
      : panel(
          "Labels",
          labelled.length,
          table(
            [{ label: "Label" }, { label: "Address" }],
            labelled.map(([address, name]) => ({
              cells: [
                link(route("run", run.id, "address", address), name),
                h("span", { class: "mono faint" }, shortHex(address, 10, 8)),
              ],
            })),
          ),
        ),
    run.gas.length === 0
      ? null
      : panel(
          "Gas snapshots",
          run.gas.length,
          table(
            [{ label: "Label" }, { label: "Gas", num: true }, { label: "Δ", num: true }],
            gasRows,
          ),
        ),
    run.http.length === 0
      ? null
      : panel(
          "HTTP replay",
          run.http.length,
          table(
            [{ label: "Request" }, { label: "Outcome" }],
            run.http.map((r) => ({
              cells: [
                h("span", { class: "mono", title: r.url }, `${r.method} ${shortUrl(r.url)}`),
                h(
                  "span",
                  {
                    class: `pill ${r.outcome === "hit" ? "ok" : r.outcome === "unmatched" ? "bad" : ""}`,
                  },
                  r.outcome,
                ),
              ],
            })),
          ),
        ),
  ];

  return [
    h(
      "div",
      { class: "page-head" },
      h("h1", { class: "mono" }, run.id),
      failed > 0
        ? h("span", { class: "pill bad" }, `${failed} failed`)
        : h("span", { class: "pill ok" }, "all passed"),
      h("span", { class: "sub" }, `${formatTime(run.startedAt)} · ${run.cwd}`),
    ),
    h(
      "div",
      { class: "stats" },
      stat("Tests", formatInt(run.tests.length)),
      stat("Passed", formatInt(passed)),
      stat("Failed", formatInt(failed)),
      stat("Transactions", formatInt(run.txs.length)),
      stat("Reverts", formatInt(run.txs.filter((t) => t.status === "reverted").length)),
      stat("Fills", formatInt(run.fills.length)),
      stat("Duration", formatMs(run.updatedAt - run.startedAt)),
    ),
    h(
      "div",
      { class: "grid" },
      h(
        "div",
        { class: "stack" },
        panel(
          "Tests",
          run.tests.length,
          rows.length === 0
            ? h("div", { class: "empty" }, "No itFork tests in this run.")
            : table(
                [
                  { label: "Test", name: true },
                  { label: "Txs", num: true },
                  { label: "Gas", num: true, hideSm: true },
                  { label: "Reverts", num: true, hideSm: true },
                  { label: "Time", num: true },
                ],
                rows,
                {},
              ),
        ),
        run.txs.length === 0 ? null : panel("Transactions", run.txs.length, txTable(idx, run.txs)),
      ),
      h("div", { class: "stack" }, side),
    ),
  ];
}

/** Every transaction in a list: what it called, where, from whom, gas, and its test. */
function txTable(idx, txs) {
  return table(
    [
      { label: "Transaction", name: true },
      { label: "Chain", hideSm: true },
      { label: "From", hideSm: true },
      { label: "Gas", num: true },
      { label: "Test", hideSm: true },
    ],
    txs.map((tx) => ({
      cells: [
        h(
          "span",
          null,
          statusDot(tx.status),
          " ",
          txLink(
            idx,
            tx,
            tx.call?.name ??
              (tx.kind === "deployContract"
                ? "deploy"
                : tx.hash
                  ? shortHex(tx.hash, 10, 6)
                  : tx.kind),
          ),
          tx.to ? [h("span", { class: "faint" }, " → "), addr(idx, tx.to)] : null,
          tx.status === "reverted" && tx.revert
            ? h("div", { class: "neg small" }, tx.revert)
            : null,
        ),
        chainChip(idx, tx.chainId),
        addr(idx, tx.from),
        tx.gasUsed ? formatInt(tx.gasUsed) : h("span", { class: "faint" }, "—"),
        testLink(idx, tx.test),
      ],
    })),
  );
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** One line of a test timeline. */
function timelineItem(idx, start, item) {
  const t = h("span", { class: "t" }, formatOffset(item.ts - start));
  const row = (tag, tagClass, what, meta) =>
    h(
      "li",
      null,
      t,
      h("span", { class: "tagcell" }, h("span", { class: `tag ${tagClass}` }, tag)),
      h("div", { class: "what" }, what),
      h("div", { class: "meta" }, meta),
    );
  switch (item.kind) {
    case "tx": {
      const tx = item.value;
      const target = tx.to ? addr(idx, tx.to) : h("span", { class: "faint" }, "new contract");
      const what = tx.call
        ? inlineCall(idx, tx.call, target)
        : tx.kind === "deployContract"
          ? h(
              "span",
              null,
              "deploy ",
              tx.contractAddress ? addr(idx, tx.contractAddress) : "contract",
            )
          : h(
              "span",
              { class: "call" },
              target,
              tx.data && tx.data !== "0x"
                ? h("span", { class: "faint" }, `.${tx.data.slice(0, 10)}(…)`)
                : h("span", { class: "faint" }, " (transfer)"),
            );
      const detail = [
        h(
          "span",
          { class: "detail" },
          "from ",
          addr(idx, tx.from),
          " · ",
          txLink(idx, tx),
          tx.status === "reverted" && tx.revert
            ? [" · ", h("span", { class: "neg" }, tx.revert)]
            : null,
        ),
      ];
      return row(
        tx.status === "reverted" ? "REVERT" : "TX",
        tx.status === "reverted" ? "revert" : "tx",
        [what, detail],
        [chainChip(idx, tx.chainId), " ", tx.gasUsed ? `${formatInt(tx.gasUsed)} gas` : ""],
      );
    }
    case "deal": {
      const d = item.value;
      return row(
        "DEAL",
        "deal",
        h(
          "span",
          null,
          "set ",
          addr(idx, d.holder),
          " to ",
          amount(idx, d.chainId, d.token, d.amount),
        ),
        chainChip(idx, d.chainId),
      );
    }
    case "fill": {
      const linked = idx.fills.find((f) => f.fill === item.value);
      const f = item.value;
      return row(
        "FILL",
        "fill",
        h(
          "span",
          null,
          h("strong", null, f.bridge),
          " ",
          chainName(idx, f.originChainId),
          " → ",
          chainName(idx, f.destinationChainId),
          " · deposit ",
          linked?.deposit ? txLink(idx, linked.deposit) : shortHex(f.depositTxHash, 10, 6),
          " filled by ",
          linked?.fillTxs.map(({ hash, tx }, i) => [
            i > 0 ? ", " : null,
            tx ? txLink(idx, tx) : shortHex(hash, 10, 6),
          ]),
        ),
        linked === undefined ? "" : fillOutput(idx, linked),
      );
    }
    case "http": {
      const r = item.value;
      return row(
        "HTTP",
        "http",
        h("span", { class: "mono", title: r.url }, `${r.method} ${shortUrl(r.url)}`),
        h(
          "span",
          { class: `pill ${r.outcome === "hit" ? "ok" : r.outcome === "unmatched" ? "bad" : ""}` },
          r.outcome,
        ),
      );
    }
    case "gas": {
      const g = item.value;
      return row(
        "GAS",
        "gas",
        h("span", null, "snapshot ", h("span", { class: "mono" }, g.label)),
        `${formatInt(g.gas)} gas`,
      );
    }
  }
  return null;
}

/** Net balance changes over a set of transactions, per chain, holder and token. */
function netChanges(txs) {
  const net = new Map();
  for (const tx of txs) {
    for (const change of tx.balanceChanges ?? []) {
      const key = `${tx.chainId}|${change.address}|${change.token}`;
      net.set(key, (net.get(key) ?? 0n) + BigInt(change.delta));
    }
  }
  return [...net]
    .filter(([, delta]) => delta !== 0n)
    .map(([key, delta]) => {
      const [chainId, address, token] = key.split("|");
      return { chainId: Number(chainId), address, token, delta: delta.toString() };
    });
}

function changesTable(idx, changes, withChain) {
  const sorted = [...changes].sort((a, b) => {
    const la = labelOf(idx, a.address) ?? a.address;
    const lb = labelOf(idx, b.address) ?? b.address;
    return la.localeCompare(lb) || a.token.localeCompare(b.token);
  });
  return table(
    [
      { label: "Holder" },
      withChain ? { label: "Chain", hideSm: true } : null,
      { label: "Change", num: true },
    ].filter(Boolean),
    sorted.map((c) => ({
      cells: [
        addr(idx, c.address),
        withChain ? chainChip(idx, c.chainId) : null,
        h(
          "span",
          null,
          amount(idx, c.chainId, c.token, c.delta, { signed: true }),
          c.after === undefined
            ? null
            : h("div", { class: "faint" }, "→ ", amount(idx, c.chainId, c.token, c.after)),
        ),
      ].filter((cell) => cell !== null),
    })),
  );
}

function viewTest(idx, key) {
  const { run } = idx;
  const test = key === SETUP ? undefined : idx.tests.get(key);
  if (key !== SETUP && test === undefined) return notFound(`No test ${key} in this run.`);
  const title = test ? test.name : "Setup & teardown";
  setCrumbs(...runCrumbs(idx, { text: title }));
  const txs = idx.txsByTest.get(key) ?? [];
  const items = [
    ...txs.map((value) => ({ kind: "tx", ts: value.ts, value })),
    ...(idx.dealsByTest.get(key) ?? []).map((value) => ({ kind: "deal", ts: value.ts, value })),
    ...(idx.fillsByTest.get(key) ?? []).map((value) => ({ kind: "fill", ts: value.ts, value })),
    ...(idx.httpByTest.get(key) ?? []).map((value) => ({ kind: "http", ts: value.ts, value })),
    ...(idx.gasByTest.get(key) ?? []).map((value) => ({ kind: "gas", ts: value.ts, value })),
  ].sort((a, b) => a.ts - b.ts);
  const start = test?.startedAt ?? items[0]?.ts ?? run.startedAt;
  const s = testStats(idx, key);
  const net = netChanges(txs);
  const chains = new Set(txs.map((t) => t.chainId));

  return [
    h(
      "div",
      { class: "page-head" },
      h("h1", null, title),
      test ? statusPill(test.status) : null,
      h(
        "span",
        { class: "sub" },
        test
          ? `${test.suite} · ${formatMs(test.durationMs)}`
          : "transactions outside any itFork test (hooks)",
      ),
    ),
    test?.error
      ? h("div", { class: "callout bad" }, h("h2", null, "Failure"), h("pre", null, test.error))
      : null,
    h(
      "div",
      { class: "stats" },
      stat("Transactions", formatInt(s.txs)),
      stat("Gas used", formatInt(s.gas.toString())),
      stat("Reverts", formatInt(s.reverts)),
      stat("Chains", formatInt(chains.size)),
    ),
    h(
      "div",
      { class: "grid" },
      h(
        "div",
        { class: "stack" },
        panel(
          "Timeline",
          items.length,
          items.length === 0
            ? h("div", { class: "empty" }, "Nothing recorded in this test.")
            : h(
                "ol",
                { class: "timeline" },
                items.map((item) => timelineItem(idx, start, item)),
              ),
        ),
      ),
      h(
        "div",
        { class: "stack" },
        panel(
          "Balance changes",
          net.length,
          net.length === 0
            ? h("div", { class: "empty" }, "No balance changes.")
            : changesTable(idx, net, chains.size > 1),
        ),
      ),
    ),
  ];
}

function frameNode(idx, frame, depth) {
  const reverted = frame.error !== undefined;
  const target = frame.to ? addr(idx, frame.to) : h("span", { class: "faint" }, "?");
  const valueText =
    frame.value && BigInt(frame.value) > 0n
      ? h("span", { class: "faint" }, ` {value: ${formatUnits(frame.value, 18)}}`)
      : null;
  const kind =
    frame.type !== "CALL" ? h("span", { class: "kind" }, ` [${frame.type.toLowerCase()}]`) : null;
  let call;
  if (frame.type === "CREATE" || frame.type === "CREATE2") {
    call = h("span", { class: "call" }, h("span", { class: "fn" }, "new "), target);
  } else if (frame.call) {
    call = inlineCall(idx, frame.call, target);
  } else if (frame.input === "0x") {
    call = h("span", { class: "call" }, target, ".", h("span", { class: "fn" }, "receive"), "()");
  } else {
    call = h(
      "span",
      { class: "call" },
      target,
      ".",
      h("span", { class: "fn" }, frame.input.slice(0, 10)),
      h("span", { class: "faint" }, `(${Math.max(0, (frame.input.length - 10) / 2)} bytes)`),
    );
  }
  const line = [
    frame.gasUsed ? h("span", { class: "gas" }, `[${formatInt(frame.gasUsed)}] `) : null,
    call,
    valueText,
    kind,
  ];
  let ret = null;
  if (reverted) {
    ret = h("div", { class: "ret bad" }, "← revert ", frame.revert ?? frame.error);
  } else if (frame.result && frame.result.length > 0) {
    ret = h(
      "div",
      { class: "ret" },
      "← ",
      frame.result.map((r, i) => [
        i > 0 ? ", " : null,
        r.type === "tuple" ? "{…}" : value(idx, r.type, r.value),
      ]),
    );
  }
  const children = frame.calls ?? [];
  if (children.length === 0) {
    return h(
      "div",
      { class: reverted ? "reverted" : null },
      h("div", { class: "leaf" }, line),
      ret,
    );
  }
  return h(
    "details",
    { open: depth < 3, class: reverted ? "reverted" : null },
    h("summary", { class: "fr" }, line),
    h(
      "div",
      { class: "children" },
      children.map((child) => frameNode(idx, child, depth + 1)),
      ret,
    ),
  );
}

function viewTx(idx, id) {
  const tx = idx.txs.get(id);
  if (tx === undefined) return notFound(`No transaction ${id} in this run.`);
  const test = tx.test ? idx.tests.get(tx.test) : undefined;
  setCrumbs(
    ...runCrumbs(
      idx,
      {
        text: test ? test.name : "setup & teardown",
        href: route("run", idx.run.id, "test", tx.test ?? SETUP),
      },
      { text: tx.hash ? shortHex(tx.hash, 10, 6) : "reverted call" },
    ),
  );
  const fee =
    tx.gasUsed !== undefined && tx.effectiveGasPrice !== undefined
      ? (BigInt(tx.gasUsed) * BigInt(tx.effectiveGasPrice)).toString()
      : undefined;
  const kv = [];
  const row = (k, v) => kv.push(h("dt", null, k), h("dd", null, v));
  row(
    "Status",
    h(
      "span",
      null,
      statusPill(tx.status),
      tx.mined ? null : h("span", { class: "faint" }, " · reverted at estimation, never mined"),
    ),
  );
  if (tx.hash) row("Hash", h("span", { class: "hash" }, tx.hash));
  row(
    "Chain",
    h("span", null, chainChip(idx, tx.chainId), h("span", { class: "faint" }, ` id ${tx.chainId}`)),
  );
  if (tx.blockNumber !== undefined) {
    row(
      "Block",
      h(
        "span",
        null,
        h("span", { class: "mono" }, formatInt(tx.blockNumber)),
        tx.blockTimestamp
          ? h(
              "span",
              { class: "faint" },
              ` · ${new Date(tx.blockTimestamp * 1000).toISOString().replace(".000Z", "Z")}`,
            )
          : null,
      ),
    );
  }
  row("Test", testLink(idx, tx.test));
  row("From", addr(idx, tx.from, { full: true }));
  if (tx.to) row("To", addr(idx, tx.to, { full: true }));
  if (tx.contractAddress) row("Created", addr(idx, tx.contractAddress, { full: true }));
  row("Value", amount(idx, tx.chainId, "native", tx.value ?? "0"));
  if (tx.call) row("Function", h("span", { class: "mono" }, tx.call.signature));
  else if (tx.functionName) row("Function", h("span", { class: "mono" }, tx.functionName));
  if (tx.gasUsed !== undefined)
    row("Gas used", h("span", { class: "mono" }, formatInt(tx.gasUsed)));
  if (tx.effectiveGasPrice !== undefined) {
    row(
      "Gas price",
      h(
        "span",
        null,
        h("span", { class: "mono" }, `${formatUnits(tx.effectiveGasPrice, 9, 4)} gwei`),
        fee ? [" · fee ", amount(idx, tx.chainId, "native", fee)] : null,
      ),
    );
  }
  row("Kind", h("span", { class: "mono" }, tx.kind));

  const linked = idx.txFill.get(tx.id);
  const input = tx.call
    ? panel(
        "Input",
        undefined,
        h(
          "div",
          { class: "panel-body" },
          h(
            "div",
            { class: "call" },
            h("span", { class: "fn" }, tx.call.name),
            h("span", { class: "faint" }, ` ${tx.call.signature}`),
          ),
        ),
        tx.call.args.length === 0 ? null : paramsTable(idx, tx.call.args),
        tx.data
          ? h(
              "details",
              { class: "raw" },
              h(
                "summary",
                { class: "raw-sum" },
                `Raw calldata (${(tx.data.length - 2) / 2} bytes)`,
              ),
              h("pre", { class: "box" }, tx.data),
            )
          : null,
      )
    : tx.data && tx.data !== "0x"
      ? panel(
          "Input",
          undefined,
          h(
            "details",
            { class: "raw", open: tx.data.length < 600 },
            h(
              "summary",
              { class: "raw-sum" },
              `Calldata (${(tx.data.length - 2) / 2} bytes, not decoded)`,
            ),
            h("pre", { class: "box" }, tx.data),
          ),
        )
      : null;

  const logs = tx.logs ?? [];
  const events = panel(
    "Events",
    logs.length,
    logs.length === 0
      ? h(
          "div",
          { class: "empty" },
          tx.mined ? "No events." : "A call reverted at estimation emits nothing.",
        )
      : h(
          "div",
          { class: "logs" },
          logs.map((log, i) =>
            h(
              "div",
              { class: "log" },
              h("span", { class: "idx" }, `#${log.logIndex ?? i}`),
              h(
                "div",
                null,
                log.event
                  ? inlineCall(idx, log.event, addr(idx, log.address))
                  : h(
                      "span",
                      null,
                      addr(idx, log.address),
                      h("span", { class: "faint" }, " unknown event"),
                    ),
                log.event
                  ? null
                  : h(
                      "pre",
                      { class: "faint" },
                      [...log.topics.map((t, j) => `topic${j} ${t}`), `data   ${log.data}`].join(
                        "\n",
                      ),
                    ),
              ),
            ),
          ),
        ),
  );

  return [
    h(
      "div",
      { class: "page-head" },
      h(
        "h1",
        null,
        tx.call ? tx.call.name : tx.kind === "deployContract" ? "Contract creation" : "Transaction",
      ),
      statusPill(tx.status),
      chainChip(idx, tx.chainId),
      h("span", { class: "sub" }, formatTime(tx.ts)),
    ),
    tx.status === "reverted"
      ? h(
          "div",
          { class: "callout bad" },
          h("h2", null, "Reverted"),
          h("div", { class: "mono" }, tx.revert ?? "no revert data"),
          tx.error && tx.error !== tx.revert && !tx.error.trim().endsWith(":")
            ? h("div", { class: "muted" }, tx.error)
            : null,
        )
      : null,
    h(
      "div",
      { class: "grid side-first" },
      h(
        "div",
        { class: "stack" },
        panel("Overview", undefined, h("dl", { class: "kv" }, kv)),
        input,
        panel(
          "Call trace",
          undefined,
          tx.trace
            ? h("div", { class: "trace" }, frameNode(idx, tx.trace, 0))
            : h("div", { class: "empty" }, "No trace recorded."),
          tx.traceText
            ? h(
                "details",
                { class: "raw" },
                h("summary", { class: "raw-sum" }, "As forge prints it"),
                h("pre", { class: "box" }, tx.traceText),
              )
            : null,
        ),
        events,
      ),
      h(
        "div",
        { class: "stack" },
        linked
          ? panel(
              linked.role === "deposit"
                ? "Cross-chain: filled on the destination"
                : "Cross-chain: fill of a deposit",
              undefined,
              fillRoute(idx, linked),
            )
          : null,
        panel(
          "Balance changes",
          tx.balanceChanges.length,
          tx.balanceChanges.length === 0
            ? h("div", { class: "empty" }, "No balance changes.")
            : changesTable(
                idx,
                tx.balanceChanges.map((c) => ({ ...c, chainId: tx.chainId })),
                false,
              ),
        ),
        tx.notes?.length
          ? panel(
              "Recording notes",
              tx.notes.length,
              h(
                "div",
                { class: "panel-body muted" },
                tx.notes.map((n) => h("div", null, n)),
              ),
            )
          : null,
      ),
    ),
  ];
}

function viewAddress(idx, address) {
  const { run } = idx;
  const lower = address.toLowerCase();
  const name = labelOf(idx, lower);
  setCrumbs(...runCrumbs(idx, { text: name ?? shortHex(lower) }));

  // Balance history per chain and token: deals set a balance, transactions change it.
  const history = new Map();
  const push = (chainId, token, entry) => {
    const key = `${chainId}|${token}`;
    if (!history.has(key)) history.set(key, { chainId, token, entries: [] });
    history.get(key).entries.push(entry);
  };
  for (const deal of run.deals) {
    if (deal.holder === lower)
      push(deal.chainId, deal.token, { ts: deal.ts, test: deal.test, deal });
  }
  const related = [];
  for (const tx of run.txs) {
    const changes = tx.balanceChanges.filter((c) => c.address === lower);
    for (const change of changes)
      push(tx.chainId, change.token, { ts: tx.ts, test: tx.test, tx, change });
    if (changes.length > 0 || tx.from === lower || tx.to === lower || tx.contractAddress === lower)
      related.push(tx);
  }
  const isToken = Object.keys(run.tokens).some((k) => k.endsWith(`:${lower}`));
  const tokenOf = Object.entries(run.tokens).find(([k]) => k.endsWith(`:${lower}`));

  const histories = [...history.values()].sort(
    (a, b) => a.chainId - b.chainId || a.token.localeCompare(b.token),
  );
  return [
    h(
      "div",
      { class: "page-head" },
      h("h1", null, name ?? "Address"),
      isToken ? h("span", { class: "pill" }, "token") : null,
    ),
    h(
      "section",
      { class: "panel" },
      h(
        "dl",
        { class: "kv" },
        h("dt", null, "Address"),
        h("dd", null, h("span", { class: "hash" }, lower)),
        h("dt", null, "Label"),
        h("dd", null, name ?? h("span", { class: "faint" }, "none")),
        tokenOf
          ? [
              h("dt", null, "Token"),
              h(
                "dd",
                null,
                `${tokenOf[1].name ?? ""} ${tokenOf[1].symbol ? `(${tokenOf[1].symbol})` : ""} · ${tokenOf[1].decimals ?? "?"} decimals`,
              ),
            ]
          : null,
        h("dt", null, "Transactions"),
        h("dd", null, formatInt(related.length)),
      ),
    ),
    h("div", { class: "spacer" }),
    h(
      "div",
      { class: "grid" },
      h(
        "div",
        { class: "stack" },
        histories.length === 0
          ? panel(
              "Balance history",
              0,
              h("div", { class: "empty" }, "No balance changes recorded for this address."),
            )
          : histories.map((hist) => {
              const info = tokenInfo(idx, hist.chainId, hist.token);
              hist.entries.sort((a, b) => a.ts - b.ts);
              return panel(
                h("span", null, `${info.symbol} balance `, chainChip(idx, hist.chainId)),
                hist.entries.length,
                table(
                  [
                    { label: "What" },
                    { label: "Change", num: true },
                    { label: "Balance", num: true },
                  ],
                  hist.entries.map((e) => ({
                    cells: [
                      h(
                        "span",
                        null,
                        e.deal
                          ? h("span", { class: "tag deal" }, "DEAL")
                          : txLink(idx, e.tx, e.tx.call?.name ?? e.tx.kind),
                        h("div", { class: "faint small" }, "in ", testLink(idx, e.test)),
                      ),
                      e.deal
                        ? h("span", { class: "faint" }, "set")
                        : amount(idx, hist.chainId, hist.token, e.change.delta, { signed: true }),
                      e.deal
                        ? amount(idx, hist.chainId, hist.token, e.deal.amount)
                        : e.change.after === undefined
                          ? h("span", { class: "faint" }, "—")
                          : amount(idx, hist.chainId, hist.token, e.change.after),
                    ],
                  })),
                ),
              );
            }),
      ),
      h(
        "div",
        { class: "stack" },
        panel(
          "Transactions",
          related.length,
          related.length === 0
            ? h("div", { class: "empty" }, "None.")
            : table(
                [{ label: "Tx" }, { label: "Test", hideSm: true }, { label: "Status" }],
                related.map((tx) => ({
                  cells: [
                    h(
                      "span",
                      null,
                      txLink(idx, tx, tx.call?.name ?? tx.kind),
                      " ",
                      chainChip(idx, tx.chainId),
                    ),
                    testLink(idx, tx.test),
                    statusPill(tx.status),
                  ],
                })),
              ),
        ),
      ),
    ),
  ];
}

function notFound(message) {
  return [
    h(
      "div",
      { class: "callout bad" },
      h("h2", null, "Not found"),
      h("p", null, message),
      link("#/", "All runs"),
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// Router

function parseRoute() {
  const parts = location.hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  return parts;
}

async function render() {
  const parts = parseRoute();
  let content;
  try {
    if (parts.length === 0) {
      runList = await getJson("/api/runs");
      current = undefined;
      content = viewRuns(runList);
    } else if (parts[0] === "run" && parts[1] !== undefined) {
      const idx = await loadRun(parts[1]);
      current = idx;
      const [, , view, arg] = parts;
      if (view === undefined) content = viewRun(idx);
      else if (view === "test") content = viewTest(idx, arg);
      else if (view === "tx") content = viewTx(idx, arg);
      else if (view === "address") content = viewAddress(idx, arg);
      else content = notFound(`Unknown view ${view}.`);
    } else {
      content = notFound("Unknown page.");
    }
  } catch (error) {
    content = [
      h(
        "div",
        { class: "callout bad" },
        h("h2", null, "Could not load"),
        h("p", null, error.message),
        link("#/", "All runs"),
      ),
    ];
  }
  app.replaceChildren(...[content].flat(Infinity).filter(Boolean));
  const title = crumbs.textContent.replaceAll("/", " / ");
  document.title = title ? `${title} · forkit explore` : "forkit explore";
  window.scrollTo(0, 0);
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = searchInput.value.trim().toLowerCase();
  if (current === undefined || query === "") return;
  const { run } = current;
  if (/^0x[0-9a-f]{40}$/.test(query)) {
    location.hash = route("run", run.id, "address", query);
  } else if (/^0x[0-9a-f]{64}$/.test(query)) {
    const tx = run.txs.find((t) => t.hash?.toLowerCase() === query);
    if (tx) location.hash = route("run", run.id, "tx", tx.id);
    else app.prepend(h("div", { class: "callout bad" }, `No transaction ${query} in this run.`));
  } else {
    const label = Object.entries(run.labels).find(([, name]) => name.toLowerCase() === query);
    if (label) location.hash = route("run", run.id, "address", label[0]);
    else
      app.prepend(
        h("div", { class: "callout bad" }, "Search by address, transaction hash or label."),
      );
  }
});

window.addEventListener("hashchange", render);
render();
