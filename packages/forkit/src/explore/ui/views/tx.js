// One transaction: the decoded call tree with each frame's events inline and an inspector, a gas
// icicle, token transfers as a flow, balances and storage before and after, events, input, and
// code that reproduces it.

import {
  copyButton,
  copyTextButton,
  cx,
  h,
  hideTip,
  icon,
  rowList,
  scrollToSection,
  setActiveNav,
  showTip,
} from "../lib/dom.js";
import {
  compact,
  formatInt,
  formatTime,
  formatUnits,
  formatUnix,
  percent,
  shortHex,
} from "../lib/format.js";
import {
  ancestors,
  balanceRows,
  defaultOpen,
  frameName,
  framesByPath,
  icicle,
  labelOf,
  parentPath,
  revertOrigin,
  route,
  snippets,
  tokenInfo,
  tokenTransfers,
  traceRows,
} from "../lib/model.js";
import {
  addr,
  amount,
  chainChip,
  empty,
  hash,
  inlineCall,
  kv,
  panel,
  paramsTable,
  rawBox,
  status,
  table,
  tag,
  testLink,
  value,
} from "../lib/ui.js";
import { fillRoute } from "./run.js";

const SECTIONS = [
  ["trace", "Call tree"],
  ["gas", "Gas"],
  ["transfers", "Transfers"],
  ["balances", "Balances"],
  ["state", "State"],
  ["events", "Events"],
  ["input", "Input"],
];

function frameTarget(idx, frame) {
  return frame.to ? addr(idx, frame.to) : h("span", { class: "faint" }, "?");
}

/** A frame's call, as one line: `USDC.transfer(to: bob, amount: 1,000,000)`. */
function frameCall(idx, frame) {
  const target = frameTarget(idx, frame);
  if (frame.type === "CREATE" || frame.type === "CREATE2")
    return h("span", { class: "call" }, h("span", { class: "fn" }, "new "), target);
  if (frame.call) return inlineCall(idx, frame.call, target);
  if (!frame.input || frame.input === "0x")
    return h("span", { class: "call" }, target, ".", h("span", { class: "fn" }, "receive"), "()");
  return h(
    "span",
    { class: "call" },
    target,
    ".",
    h("span", { class: "fn mono" }, frame.input.slice(0, 10)),
    h("span", { class: "faint" }, `(${Math.max(0, (frame.input.length - 10) / 2)} bytes)`),
  );
}

function frameResult(idx, frame) {
  if (frame.error !== undefined)
    return h("span", { class: "ret is-bad" }, icon("fail"), " ", frame.revert ?? frame.error);
  if (frame.result && frame.result.length > 0)
    return h(
      "span",
      { class: "ret" },
      "→ ",
      frame.result.map((r, i) => [
        i > 0 ? ", " : null,
        value(idx, r.type, r.value, { inline: true }),
      ]),
    );
  return null;
}

function eventLine(idx, log) {
  return log.event
    ? inlineCall(idx, log.event, addr(idx, log.address))
    : h(
        "span",
        { class: "call" },
        addr(idx, log.address),
        h("span", { class: "faint" }, ` event ${shortHex(log.topics[0] ?? "anonymous", 10, 4)}`),
      );
}

// ---------------------------------------------------------------------------------------------
// The call tree

function traceRow(idx, row, total, onToggle) {
  if (row.type === "log") {
    const el = h(
      "div",
      { class: "tr tr-log" },
      h("span", { class: "tr-gas" }),
      h(
        "span",
        { class: "tr-body" },
        h("span", { class: "tr-indent" }),
        tag("emit", "event"),
        " ",
        eventLine(idx, row.log),
      ),
    );
    el.style.setProperty("--depth", String(row.depth));
    return el;
  }
  const { frame } = row;
  const gas = BigInt(frame.gasUsed ?? 0);
  const bar = h("span", { class: "tr-bar" });
  bar.style.width = `${total > 0n ? Math.max(2, (Number(gas) / Number(total)) * 100) : 0}%`;
  const el = h(
    "div",
    { class: cx("tr", frame.error !== undefined && "is-bad") },
    h(
      "span",
      { class: "tr-gas mono", title: `${formatInt(gas)} gas (${percent(gas, total)})` },
      h("span", { class: "tr-bar-track" }, bar),
      compact(gas),
    ),
    h(
      "span",
      { class: "tr-body" },
      h("span", { class: "tr-indent" }),
      row.hasChildren
        ? h(
            "button",
            {
              type: "button",
              class: cx("toggle", row.open && "is-open"),
              "aria-label": row.open ? "Collapse" : "Expand",
              "aria-expanded": String(row.open),
              onclick: (event) => {
                event.stopPropagation();
                onToggle(row.path);
              },
            },
            icon("chevron"),
          )
        : h("span", { class: "toggle-space" }),
      frame.type !== "CALL" ? tag(frame.type.toLowerCase(), "kind") : null,
      frame.value && BigInt(frame.value) > 0n
        ? tag(`${formatUnits(frame.value, 18)} value`, "value")
        : null,
      frameCall(idx, frame),
      " ",
      frameResult(idx, frame),
    ),
  );
  el.style.setProperty("--depth", String(row.depth));
  return el;
}

function inspector(idx, tx, frame, path, total) {
  if (!frame) return h("div", { class: "inspector" }, empty("Select a frame."));
  const own = (frame.logs ?? []).length;
  return h(
    "div",
    { class: "inspector", "aria-live": "polite" },
    h(
      "header",
      null,
      h("h3", null, frame.call?.name ?? frameName(frame)),
      tag(frame.type.toLowerCase(), "kind"),
      frame.error !== undefined ? status("reverted") : null,
      h("span", { class: "faint mono" }, `frame ${path}`),
      copyButton(
        `${location.href.split("#")[0]}${route(["run", idx.run.id, "tx", tx.id], { frame: path })}`,
        "link to this frame",
      ),
    ),
    kv([
      ["From", addr(idx, frame.from, { copy: true })],
      frame.to ? ["To", addr(idx, frame.to, { copy: true, full: true })] : null,
      frame.value && BigInt(frame.value) > 0n
        ? ["Value", amount(idx, tx.chainId, "native", frame.value)]
        : null,
      [
        "Gas used",
        h(
          "span",
          null,
          h("span", { class: "mono" }, formatInt(frame.gasUsed ?? 0)),
          h(
            "span",
            { class: "faint" },
            ` · ${percent(BigInt(frame.gasUsed ?? 0), total)} of the transaction`,
          ),
        ),
      ],
      frame.call ? ["Function", h("span", { class: "mono wrap" }, frame.call.signature)] : null,
      frame.error !== undefined
        ? ["Revert", h("span", { class: "neg" }, frame.revert ?? frame.error)]
        : null,
      own > 0 ? ["Events", `${own} emitted here`] : null,
    ]),
    frame.call && frame.call.args.length > 0
      ? [h("h4", null, "Arguments"), paramsTable(idx, frame.call.args)]
      : null,
    frame.result && frame.result.length > 0
      ? [h("h4", null, "Returns"), paramsTable(idx, frame.result)]
      : null,
    own > 0
      ? [
          h("h4", null, "Events"),
          h(
            "ol",
            { class: "evlist" },
            frame.logs.map((log) => h("li", null, eventLine(idx, log))),
          ),
        ]
      : null,
    rawBox(`Input (${Math.max(0, (frame.input.length - 2) / 2)} bytes)`, frame.input),
    frame.output && frame.output !== "0x"
      ? rawBox(`Output (${(frame.output.length - 2) / 2} bytes)`, frame.output)
      : null,
  );
}

function callTree(idx, tx, ctx) {
  const frames = framesByPath(tx.trace);
  const total = BigInt(tx.trace.gasUsed ?? 0);
  const open = defaultOpen(tx.trace);
  let selected = ctx.params.get("frame");
  if (!frames.has(selected)) selected = revertOrigin(tx.trace)?.path ?? "0";
  for (const a of ancestors(selected)) open.add(a);

  const holder = h("div", { class: "tree" });
  const inspectorHolder = h("div", { class: "inspector-wrap" });
  let list;

  const showInspector = () =>
    inspectorHolder.replaceChildren(inspector(idx, tx, frames.get(selected), selected, total));

  const toggle = (path, force) => {
    const isOpen = open.has(path);
    const next = force ?? !isOpen;
    if (next === isOpen) return;
    if (next) open.add(path);
    else open.delete(path);
    build();
  };

  const build = () => {
    const rows = traceRows(tx.trace, open);
    const at = rows.findIndex((r) => r.type === "frame" && r.path === selected);
    const scroll = list?.el.scrollTop ?? 0;
    list = rowList({
      items: rows,
      label: "Call tree",
      rowHeight: 34,
      threshold: 300,
      className: "trace-rows",
      selected: at === -1 ? 0 : at,
      onSelect: (row) => {
        const path = row.type === "frame" ? row.path : parentPath(`${row.path.split("#")[0]}.x`);
        if (path !== selected) {
          selected = path;
          ctx.setParams({ frame: selected });
          showInspector();
          highlightCell(selected);
        }
      },
      onActivate: (row) => {
        if (row.type === "frame" && row.hasChildren) toggle(row.path);
      },
      render: (row) => traceRow(idx, row, total, (path) => toggle(path)),
    });
    list.left = () => {
      const row = list.items[list.selected];
      if (row?.type === "frame" && row.open) toggle(row.path, false);
      else {
        const parent = parentPath(
          row?.type === "frame" ? row.path : `${row?.path.split("#")[0]}.x`,
        );
        const i = list.items.findIndex((r) => r.type === "frame" && r.path === parent);
        if (i >= 0) list.select(i);
      }
    };
    list.right = () => {
      const row = list.items[list.selected];
      if (row?.type === "frame" && row.hasChildren && !row.open) toggle(row.path, true);
      else list.select(list.selected + 1);
    };
    holder.replaceChildren(list.el);
    list.el.scrollTop = scroll;
    setActiveNav(list);
  };

  // The icicle selects frames too.
  let highlightCell = () => {};
  const selectPath = (path) => {
    selected = path;
    for (const a of ancestors(path)) open.add(a);
    build();
    const i = list.items.findIndex((r) => r.type === "frame" && r.path === path);
    if (i >= 0) list.select(i, { silent: true });
    ctx.setParams({ frame: path });
    showInspector();
    highlightCell(path);
  };

  build();
  showInspector();
  const el = h(
    "div",
    { class: "tree-split" },
    h(
      "div",
      { class: "tree-col" },
      holder,
      h(
        "p",
        { class: "hint" },
        h("kbd", null, "j"),
        h("kbd", null, "k"),
        " move · ",
        h("kbd", null, "h"),
        h("kbd", null, "l"),
        " collapse and expand · ",
        h("kbd", null, "↵"),
        " toggle",
      ),
    ),
    inspectorHolder,
  );
  return {
    el,
    selectPath,
    setHighlighter(fn) {
      highlightCell = fn;
      fn(selected);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Gas icicle

function gasIcicle(idx, tx, onPick) {
  const { cells, depth, total } = icicle(tx.trace);
  const ROW = 28;
  const plot = h("div", {
    class: "icicle",
    role: "group",
    "aria-label": "Gas used by each call frame",
  });
  plot.style.height = `${depth * ROW}px`;
  const byPath = new Map();
  for (const cell of cells) {
    const width = cell.x1 - cell.x0;
    if (width < 0.002) continue;
    const name = `${labelOf(idx, cell.frame.to) ?? idx.tokenByAddress.get(cell.frame.to)?.symbol ?? shortHex(cell.frame.to ?? "?")}.${frameName(cell.frame)}`;
    const label = h(
      "span",
      { class: "ic-label" },
      cell.frame.error !== undefined ? icon("fail") : null,
      h("span", null, name),
      h("span", { class: "ic-gas" }, compact(cell.gas)),
    );
    const el = h(
      "button",
      {
        type: "button",
        class: cx("ic", cell.frame.error !== undefined && "is-bad"),
        "aria-label": `${name}: ${formatInt(cell.gas)} gas, ${percent(cell.gas, total)} of the transaction`,
        onclick: () => onPick(cell.path),
        onpointermove: (event) =>
          showTip(
            [
              h("strong", null, name),
              h("div", null, `${formatInt(cell.gas)} gas · ${percent(cell.gas, total)}`),
              cell.frame.error !== undefined
                ? h("div", { class: "neg" }, cell.frame.revert ?? "reverted")
                : null,
            ],
            event.clientX,
            event.clientY,
          ),
        onpointerleave: hideTip,
        onblur: hideTip,
      },
      label,
    );
    el.style.left = `${cell.x0 * 100}%`;
    el.style.width = `${width * 100}%`;
    el.style.top = `${cell.depth * ROW}px`;
    el.dataset.chars = String(name.length + compact(cell.gas).length + 2);
    el.dataset.w = String(width);
    byPath.set(cell.path, el);
    plot.append(el);
  }
  // Labels only where they fit: measured against the plot's width, never clipped mid-glyph.
  const fit = () => {
    const w = plot.clientWidth;
    if (w === 0) return;
    for (const el of byPath.values()) {
      const px = Number(el.dataset.w) * w;
      el.classList.toggle("has-label", px >= Number(el.dataset.chars) * 7 + 16);
    }
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(fit).observe(plot);
  requestAnimationFrame(fit);
  const highlight = (path) => {
    for (const [p, el] of byPath) {
      el.classList.toggle("is-selected", p === path);
      el.setAttribute("aria-pressed", String(p === path));
    }
  };
  // The plot keeps a legible width on a phone; its container scrolls.
  const wrap = h(
    "div",
    { class: "icicle-wrap", tabindex: "0", role: "region", "aria-label": "Gas icicle" },
    plot,
  );
  return {
    el: h(
      "div",
      null,
      h(
        "p",
        { class: "caption" },
        "Each bar is a call; its width is the gas it used, children inside their caller. ",
        h("span", { class: "hide-sm" }, "Click one to inspect it."),
      ),
      wrap,
    ),
    highlight,
  };
}

// ---------------------------------------------------------------------------------------------
// Transfers, balances, state

function transfersFlow(idx, tx) {
  const transfers = tokenTransfers(tx);
  if (transfers.length === 0)
    return empty(tx.mined ? "No tokens or ether moved." : "Nothing moved: it never ran on chain.");
  return h(
    "ol",
    { class: "flow" },
    transfers.map((t, i) =>
      h(
        "li",
        { class: "flow-row" },
        h("span", { class: "flow-n mono faint" }, String(i + 1)),
        h("span", { class: "flow-from" }, addr(idx, t.from)),
        h(
          "span",
          { class: "flow-edge" },
          h("span", { class: "flow-amt" }, amount(idx, tx.chainId, t.token, t.amount)),
          icon("arrow"),
        ),
        h("span", { class: "flow-to" }, addr(idx, t.to)),
      ),
    ),
  );
}

function balancesTable(idx, tx) {
  const rows = balanceRows(tx).sort(
    (a, b) =>
      (labelOf(idx, a.address) ?? a.address).localeCompare(labelOf(idx, b.address) ?? b.address) ||
      a.token.localeCompare(b.token),
  );
  if (rows.length === 0) return empty("No balance changes.");
  const plain = { plain: true };
  return table(
    [
      { label: "Holder" },
      { label: "Before", num: true, hideSm: true },
      { label: "After", num: true },
      { label: "Change", num: true },
    ],
    rows.map((c) => ({
      cells: [
        addr(idx, c.address),
        c.before === undefined
          ? h("span", { class: "faint" }, "—")
          : amount(idx, tx.chainId, c.token, c.before, plain),
        c.after === undefined
          ? h("span", { class: "faint" }, "—")
          : amount(idx, tx.chainId, c.token, c.after, plain),
        amount(idx, tx.chainId, c.token, c.delta, { signed: true }),
      ],
    })),
    { label: "Balance changes", className: "balances" },
  );
}

const MAX_UINT128 = (1n << 128n) - 1n;

/** A storage word, read the likeliest way: an address, a number, or hex. */
function wordValue(idx, tx, account, slot, word) {
  const n = BigInt(word);
  if (n === 0n) return h("span", { class: "mono faint" }, "0");
  if (/^0x0{24}[0-9a-f]{40}$/i.test(word) && n > MAX_UINT128)
    return addr(idx, `0x${word.slice(26)}`);
  if (n <= MAX_UINT128) {
    // A token's `mapping(n)[holder]` slot is almost always a balance or an allowance.
    const token = idx.tokenByAddress.get(account);
    if (token?.decimals !== undefined && /^mapping\(\d+\)\[/.test(slot.hint ?? "")) {
      return h(
        "span",
        { title: `${n} (raw)` },
        amount(idx, tx.chainId, account, n.toString(), { plain: true }),
      );
    }
    return h("span", { class: "mono", title: word }, formatInt(n));
  }
  return h("span", { class: "mono", title: word }, shortHex(word, 10, 8));
}

function stateDiffView(idx, tx) {
  const diff = tx.stateDiff;
  if (diff === undefined)
    return empty(
      tx.mined
        ? "No state diff recorded (a node without the prestate tracer)."
        : "It never ran on chain: no state changed.",
    );
  if (diff.length === 0) return empty("No state changed.");
  const native = tokenInfo(idx, tx.chainId, "native").symbol;
  return h(
    "div",
    { class: "accounts" },
    diff.map((a) => {
      const bits = [
        a.balance ? `${native}` : null,
        a.nonce ? "nonce" : null,
        a.code ? "code" : null,
        a.storage.length > 0 ? `${a.storage.length} slot${a.storage.length > 1 ? "s" : ""}` : null,
      ].filter(Boolean);
      const quiet =
        a.storage.length === 0 && !a.code && labelOf(idx, a.address) === undefined && !a.nonce;
      return h(
        "details",
        { class: "account", open: !quiet },
        h(
          "summary",
          null,
          icon("chevron"),
          addr(idx, a.address),
          h("span", { class: "faint" }, ` ${bits.join(" · ")}`),
        ),
        h(
          "div",
          { class: "account-body" },
          kv([
            a.balance
              ? [
                  native,
                  h(
                    "span",
                    { class: "delta" },
                    amount(idx, tx.chainId, "native", a.balance.before),
                    h("span", { class: "faint" }, " → "),
                    amount(idx, tx.chainId, "native", a.balance.after),
                    " ",
                    amount(
                      idx,
                      tx.chainId,
                      "native",
                      (BigInt(a.balance.after) - BigInt(a.balance.before)).toString(),
                      { signed: true },
                    ),
                  ),
                ]
              : null,
            a.nonce
              ? ["Nonce", h("span", { class: "mono" }, `${a.nonce.before} → ${a.nonce.after}`)]
              : null,
            a.code
              ? [
                  "Code",
                  h(
                    "span",
                    { class: "mono" },
                    `${formatInt(a.code.before)} → ${formatInt(a.code.after)} bytes`,
                  ),
                ]
              : null,
          ]),
          a.storage.length === 0
            ? null
            : table(
                [{ label: "Slot" }, { label: "Before", num: true }, { label: "After", num: true }],
                a.storage.map((slot) => ({
                  cells: [
                    h(
                      "span",
                      { class: "hashline" },
                      h(
                        "span",
                        { class: cx("mono", !slot.hint && "faint"), title: slot.slot },
                        slot.hint ?? shortHex(slot.slot, 10, 6),
                      ),
                      copyButton(slot.slot, "slot"),
                    ),
                    wordValue(idx, tx, a.address, slot, slot.before),
                    wordValue(idx, tx, a.address, slot, slot.after),
                  ],
                })),
                { label: "Storage", className: "slots" },
              ),
        ),
      );
    }),
  );
}

function eventsList(idx, tx, onFrame) {
  const logs = tx.logs ?? [];
  if (logs.length === 0)
    return empty(tx.mined ? "No events." : "A call reverted at estimation emits nothing.");
  // Where each receipt log was emitted: the frame whose own logs hold its index.
  const at = new Map();
  for (const [path, frame] of framesByPath(tx.trace))
    for (const log of frame.logs ?? []) if (log.index !== undefined) at.set(log.index, path);
  return h(
    "ol",
    { class: "events" },
    logs.map((log, i) => {
      const index = log.logIndex ?? i;
      const path = at.get(index);
      return h(
        "li",
        { class: "event" },
        h("span", { class: "ev-i mono faint" }, `#${index}`),
        h(
          "div",
          { class: "ev-body" },
          h("div", { class: "line" }, eventLine(idx, log)),
          path
            ? h(
                "button",
                { type: "button", class: "linkish small", onclick: () => onFrame(path) },
                `emitted by frame ${path}`,
              )
            : null,
          log.event
            ? null
            : rawBox(
                "Topics and data",
                [...log.topics.map((t, j) => `topic${j} ${t}`), `data   ${log.data}`].join("\n"),
              ),
        ),
      );
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Copy as code

function codeDialog(idx, tx) {
  const { viem, forkit } = snippets(idx, tx);
  const block = (title, note, code) =>
    h(
      "section",
      { class: "snippet" },
      h("header", null, h("h3", null, title), copyTextButton(code, `Copy ${title}`)),
      h("p", { class: "faint small" }, note),
      h("pre", { class: "box code", tabindex: "0" }, code),
    );
  const dialog = h(
    "dialog",
    { class: "dialog", "aria-labelledby": "code-title" },
    h(
      "div",
      { class: "dialog-head" },
      h("h2", { id: "code-title" }, "Reproduce this transaction"),
      h("button", { type: "button", class: "btn ghost", onclick: () => dialog.close() }, "Close"),
    ),
    block(
      "forkit",
      "An itFork test that replays this test's steps on this chain up to this transaction.",
      forkit,
    ),
    block("viem", "The one transaction, sent as its sender on an anvil fork.", viem),
  );
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  const button = h(
    "button",
    { type: "button", class: "btn", onclick: () => dialog.showModal() },
    icon("code"),
    "Copy as code",
  );
  return { button, dialog };
}

// ---------------------------------------------------------------------------------------------

export function viewTx(idx, id, ctx) {
  const tx = idx.txs.get(id);
  if (tx === undefined) return undefined;
  const test = tx.test ? idx.tests.get(tx.test) : undefined;
  const fee =
    tx.gasUsed !== undefined && tx.effectiveGasPrice !== undefined
      ? (BigInt(tx.gasUsed) * BigInt(tx.effectiveGasPrice)).toString()
      : undefined;
  const title = tx.call
    ? tx.call.name
    : tx.kind === "deployContract"
      ? "Contract creation"
      : tx.data && tx.data !== "0x"
        ? tx.data.slice(0, 10)
        : "Transfer";
  const origin = tx.trace ? revertOrigin(tx.trace) : undefined;
  const linked = idx.txFill.get(tx.id);
  const code = codeDialog(idx, tx);

  const tree = tx.trace ? callTree(idx, tx, ctx) : undefined;
  const ice = tx.trace
    ? gasIcicle(idx, tx, (path) => {
        tree?.selectPath(path);
        scrollToSection("trace");
      })
    : undefined;
  if (tree && ice) tree.setHighlighter(ice.highlight);

  const overview = kv([
    [
      "Status",
      h(
        "span",
        null,
        status(tx.status),
        tx.mined ? null : h("span", { class: "faint" }, " · reverted at estimation, never mined"),
      ),
    ],
    tx.hash ? ["Hash", hash(tx.hash, { what: "transaction hash" })] : null,
    ["From", addr(idx, tx.from, { full: true, copy: true })],
    tx.to ? ["To", addr(idx, tx.to, { full: true, copy: true })] : null,
    tx.contractAddress
      ? ["Created", addr(idx, tx.contractAddress, { full: true, copy: true })]
      : null,
    ["Value", amount(idx, tx.chainId, "native", tx.value ?? "0")],
    tx.gasUsed !== undefined
      ? [
          "Gas",
          h(
            "span",
            null,
            h("span", { class: "mono" }, formatInt(tx.gasUsed)),
            tx.effectiveGasPrice
              ? h("span", { class: "faint" }, ` at ${formatUnits(tx.effectiveGasPrice, 9, 4)} gwei`)
              : null,
            fee
              ? [h("span", { class: "faint" }, " · fee "), amount(idx, tx.chainId, "native", fee)]
              : null,
          ),
        ]
      : null,
    [
      "Chain",
      h(
        "span",
        null,
        chainChip(idx, tx.chainId),
        tx.blockNumber !== undefined
          ? h("span", { class: "mono" }, ` block ${formatInt(tx.blockNumber)}`)
          : null,
        tx.blockTimestamp
          ? h("span", { class: "faint" }, ` · ${formatUnix(tx.blockTimestamp)}`)
          : null,
      ),
    ],
    ["Test", testLink(idx, tx.test)],
    tx.call ? ["Function", h("span", { class: "mono wrap" }, tx.call.signature)] : null,
  ]);

  const nav = h(
    "nav",
    { class: "section-nav", "aria-label": "Sections" },
    SECTIONS.map(([sid, label]) =>
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            scrollToSection(sid);
            ctx.setParams({ section: sid });
          },
        },
        label,
      ),
    ),
  );

  const section = ctx.params.get("section");
  if (section)
    requestAnimationFrame(() =>
      document.getElementById(section)?.scrollIntoView({ block: "start" }),
    );

  const siblings = idx.txsByTest.get(tx.test ?? "setup") ?? [];
  const at = siblings.indexOf(tx);
  const prev = siblings[at - 1];
  const next = siblings[at + 1];

  return {
    title: `${title} · ${tx.hash ? shortHex(tx.hash, 10, 6) : "reverted call"}`,
    crumbs: [
      { text: "Runs", href: "#/" },
      { text: idx.run.id, href: route(["run", idx.run.id]) },
      {
        text: test ? test.name : "setup & teardown",
        href: route(["run", idx.run.id, "test", tx.test ?? "setup"]),
      },
      { text: tx.hash ? shortHex(tx.hash, 8, 4) : "reverted call" },
    ],
    body: [
      h(
        "div",
        { class: "page-head" },
        h("h1", null, title),
        status(tx.status),
        chainChip(idx, tx.chainId),
        h("span", { class: "sub" }, formatTime(tx.ts)),
        h(
          "div",
          { class: "head-actions" },
          prev
            ? h(
                "a",
                {
                  class: "btn ghost",
                  href: route(["run", idx.run.id, "tx", prev.id]),
                  title: "Previous transaction in this test",
                },
                "← prev",
              )
            : null,
          next
            ? h(
                "a",
                {
                  class: "btn ghost",
                  href: route(["run", idx.run.id, "tx", next.id]),
                  title: "Next transaction in this test",
                },
                "next →",
              )
            : null,
          code.button,
        ),
      ),
      code.dialog,
      tx.status === "reverted"
        ? h(
            "div",
            { class: "callout is-bad" },
            h("h2", null, icon("fail"), " Reverted"),
            h("p", { class: "mono wrap" }, tx.revert ?? "no revert data"),
            origin && origin.path !== "0"
              ? h(
                  "p",
                  null,
                  "It started in ",
                  h(
                    "button",
                    {
                      type: "button",
                      class: "linkish",
                      onclick: () => tree?.selectPath(origin.path),
                    },
                    frameCall(idx, origin.frame),
                  ),
                  ".",
                )
              : null,
            tx.error && tx.error !== tx.revert && !tx.error.trim().endsWith(":")
              ? h("p", { class: "muted small" }, tx.error)
              : null,
          )
        : null,
      panel("Overview", { id: "overview" }, overview),
      nav,
      linked
        ? panel(
            linked.role === "deposit"
              ? "Cross-chain: filled on the destination"
              : "Cross-chain: fill of a deposit",
            { id: "fill" },
            fillRoute(idx, linked),
          )
        : null,
      panel(
        "Call tree",
        { id: "trace", className: "trace-panel" },
        tree ? tree.el : empty("No trace recorded."),
        tx.traceText ? rawBox("As forge -vvvv prints it", tx.traceText) : null,
      ),
      h(
        "div",
        { class: "grid halves" },
        panel(
          "Token transfers",
          { id: "transfers", count: tokenTransfers(tx).length },
          transfersFlow(idx, tx),
        ),
        panel(
          "Balance changes",
          { id: "balances", count: tx.balanceChanges.length },
          balancesTable(idx, tx),
        ),
      ),
      panel("Gas by call", { id: "gas" }, ice ? ice.el : empty("No trace recorded.")),
      panel("State changes", { id: "state", count: tx.stateDiff?.length }, stateDiffView(idx, tx)),
      panel(
        "Events",
        { id: "events", count: (tx.logs ?? []).length },
        eventsList(idx, tx, (path) => {
          tree?.selectPath(path);
          scrollToSection("trace");
        }),
      ),
      panel(
        "Input",
        { id: "input" },
        tx.call
          ? [
              h("p", { class: "mono wrap small" }, tx.call.signature),
              tx.call.args.length === 0 ? null : paramsTable(idx, tx.call.args),
            ]
          : empty(
              tx.data && tx.data !== "0x"
                ? "Calldata not decoded: no known ABI has its selector."
                : "No calldata.",
            ),
        tx.data && tx.data !== "0x"
          ? rawBox(
              `Raw calldata (${(tx.data.length - 2) / 2} bytes)`,
              tx.data,
              !tx.call && tx.data.length < 600,
            )
          : null,
      ),
      tx.notes?.length
        ? panel(
            "Recording notes",
            { count: tx.notes.length },
            h(
              "ul",
              { class: "notes" },
              tx.notes.map((n) => h("li", null, n)),
            ),
          )
        : null,
    ],
  };
}
