// One address: its label, balance of each token over the run (a chart and a table), every
// transaction that touched it, and the storage it had changed.

import { copyButton, cx, h, hideTip, s, showTip } from "../lib/dom.js";
import { formatInt, formatUnits, shortHex } from "../lib/format.js";
import { addressTxs, balanceSeries, chainName, labelOf, route, tokenInfo } from "../lib/model.js";
import {
  amount,
  chainChip,
  empty,
  kv,
  panel,
  statTile,
  table,
  tag,
  testLink,
  txLink,
} from "../lib/ui.js";
import { txRows } from "./run.js";

const scaled = (raw, decimals) =>
  decimals === undefined
    ? Number(raw)
    : Number(formatUnits(raw, decimals, 6).replaceAll(",", "").replace("<", ""));

/**
 * A step line of one token's balance over the run's steps. One series, so no legend: the panel
 * title names it. Hover (or focus) a point for its value and the step that set it; the table
 * under it holds every value.
 */
function balanceChart(idx, series) {
  const info = tokenInfo(idx, series.chainId, series.token);
  const points = series.points.filter((p) => p.value !== undefined);
  const holder = h("div", { class: "chart" });
  if (points.length === 0) return holder;
  const values = points.map((p) => scaled(p.value, info.decimals));
  const max = Math.max(...values, 0);
  const maxRaw = points[values.indexOf(max)]?.value ?? "0";
  const H = 132;
  const PAD = { l: 16, r: 20, t: 22, b: 22 };

  const draw = () => {
    const W = Math.max(240, holder.clientWidth || 560);
    const x = (i) =>
      PAD.l +
      (points.length === 1
        ? (W - PAD.l - PAD.r) / 2
        : (i / (points.length - 1)) * (W - PAD.l - PAD.r));
    const y = (v) => PAD.t + (max === 0 ? H - PAD.t - PAD.b : (1 - v / max) * (H - PAD.t - PAD.b));
    let d = "";
    points.forEach((_, i) => {
      d += i === 0 ? `M${x(i)},${y(values[i])}` : `H${x(i)}V${y(values[i])}`;
    });
    // Test boundaries: every test starts from its snapshot, so a balance can jump back.
    const bounds = [];
    for (let i = 1; i < points.length; i++)
      if (points[i].test !== points[i - 1].test) bounds.push((x(i - 1) + x(i)) / 2);
    const fmt = (raw) =>
      info.decimals === undefined ? formatInt(raw) : formatUnits(raw, info.decimals, 4);
    const svg = s(
      "svg",
      {
        width: W,
        height: H,
        viewBox: `0 0 ${W} ${H}`,
        role: "img",
        "aria-label": `${info.symbol} balance at each of ${points.length} steps, from ${fmt(points[0].value)} to ${fmt(points[points.length - 1].value)}`,
      },
      s("line", { class: "grid-line", x1: PAD.l, x2: W - PAD.r, y1: y(0), y2: y(0) }),
      s("line", { class: "grid-line", x1: PAD.l, x2: W - PAD.r, y1: y(max), y2: y(max) }),
      s("text", { class: "axis", x: PAD.l, y: y(max) - 6 }, `${fmt(maxRaw)} ${info.symbol}`),
      s("text", { class: "axis", x: PAD.l, y: y(0) + 15 }, "0"),
      bounds.map((bx) =>
        s("line", { class: "test-bound", x1: bx, x2: bx, y1: PAD.t - 6, y2: H - PAD.b + 4 }),
      ),
      s("path", { class: "series", d }),
      points.map((_p, i) =>
        s("circle", {
          class: cx("pt", i === points.length - 1 && "is-last"),
          cx: x(i),
          cy: y(values[i]),
          r: 4,
        }),
      ),
      // Hit targets bigger than the marks.
      points.map((p, i) => {
        const tipBody = () => [
          h("strong", null, `${fmt(p.value)} ${info.symbol}`),
          h("div", null, p.deal ? "set by deal" : `after ${p.tx.call?.name ?? p.tx.kind}`),
          h("div", { class: "faint" }, idx.tests.get(p.test)?.name ?? "setup"),
        ];
        return s("circle", {
          class: "hit",
          cx: x(i),
          cy: y(values[i]),
          r: 12,
          tabindex: "0",
          role: "button",
          "aria-label": `${fmt(p.value)} ${info.symbol}, ${p.deal ? "set by deal" : `after ${p.tx.call?.name ?? p.tx.kind}`}`,
          onpointermove: (e) => showTip(tipBody(), e.clientX, e.clientY),
          onpointerleave: hideTip,
          onfocus: (e) => {
            const r = e.target.getBoundingClientRect();
            showTip(tipBody(), r.right, r.top);
          },
          onblur: hideTip,
          onclick: () => {
            if (p.tx) location.hash = route(["run", idx.run.id, "tx", p.tx.id]);
          },
        });
      }),
      // The endpoint's value, directly labelled.
      s(
        "text",
        {
          class: "end-label",
          x: x(points.length - 1),
          y: y(values[values.length - 1]) - 9,
          "text-anchor": points.length === 1 ? "middle" : "end",
        },
        fmt(points[points.length - 1].value),
      ),
    );
    holder.replaceChildren(svg);
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(draw).observe(holder);
  requestAnimationFrame(draw);
  draw();
  return holder;
}

function historyTable(idx, series) {
  return table(
    [
      { label: "Step" },
      { label: "Test", hideSm: true },
      { label: "Change", num: true },
      { label: "Balance", num: true },
    ],
    series.points.map((e) => ({
      cells: [
        e.deal ? tag("deal", "cheat") : txLink(idx, e.tx, e.tx.call?.name ?? e.tx.kind),
        testLink(idx, e.test),
        e.deal
          ? h("span", { class: "faint" }, "set")
          : amount(idx, series.chainId, series.token, e.change.delta, { signed: true }),
        e.value === undefined
          ? h("span", { class: "faint" }, "—")
          : amount(idx, series.chainId, series.token, e.value, { plain: true }),
      ],
    })),
    { label: "Balance history" },
  );
}

/** The slots of this address that transactions changed: first value and last. */
function storageChanges(idx, lower) {
  const slots = new Map();
  for (const tx of idx.run.txs) {
    for (const account of tx.stateDiff ?? []) {
      if (account.address !== lower) continue;
      for (const slot of account.storage) {
        const seen = slots.get(slot.slot);
        if (seen) {
          seen.after = slot.after;
          seen.txs.push(tx);
        } else slots.set(slot.slot, { ...slot, txs: [tx] });
      }
    }
  }
  return [...slots.values()];
}

export function viewAddress(idx, address, ctx) {
  const { run } = idx;
  const lower = address.toLowerCase();
  const name = labelOf(idx, lower);
  const token = idx.tokenByAddress.get(lower);
  const series = balanceSeries(idx, lower);
  const related = addressTxs(idx, lower);
  const storage = storageChanges(idx, lower);
  const sent = related.filter((t) => t.from === lower).length;
  const list = txRows(idx, related, ctx.go, {
    withTest: true,
    label: "Transactions touching this address",
  });
  const title = name ?? token?.symbol ?? shortHex(lower);

  return {
    title,
    nav: list,
    crumbs: [
      { text: "Runs", href: "#/" },
      { text: run.id, href: route(["run", run.id]) },
      { text: title },
    ],
    body: [
      h(
        "div",
        { class: "page-head" },
        h("h1", null, name ?? token?.symbol ?? "Address"),
        token ? tag("token", "kind") : null,
        h(
          "span",
          { class: "sub hashline" },
          h("span", { class: "mono wrap" }, lower),
          copyButton(lower, "address"),
        ),
      ),
      h(
        "div",
        { class: "stats" },
        statTile("Transactions", formatInt(related.length), `${sent} sent`),
        statTile(
          "Balances",
          formatInt(series.length),
          series.length
            ? series.map((x) => tokenInfo(idx, x.chainId, x.token).symbol).join(", ")
            : "none moved",
        ),
        statTile(
          "Storage slots",
          formatInt(storage.length),
          storage.length ? "changed in this run" : null,
        ),
      ),
      token
        ? panel(
            "Token",
            null,
            kv([
              ["Name", token.name ?? "—"],
              ["Symbol", token.symbol ?? "—"],
              ["Decimals", token.decimals ?? "—"],
              ["Chain", chainName(idx, token.chainId)],
            ]),
          )
        : null,
      h(
        "div",
        { class: "grid" },
        h(
          "div",
          { class: "stack" },
          series.length === 0
            ? panel(
                "Balance over the run",
                { id: "balances" },
                empty("No balance changes recorded for this address."),
              )
            : series.map((x) => {
                const info = tokenInfo(idx, x.chainId, x.token);
                return panel(
                  h("span", null, `${info.symbol} balance `, chainChip(idx, x.chainId)),
                  { count: x.points.length, className: "chart-panel" },
                  balanceChart(idx, x),
                  h(
                    "details",
                    { class: "raw" },
                    h("summary", null, "Every step as a table"),
                    historyTable(idx, x),
                  ),
                );
              }),
          storage.length === 0
            ? null
            : panel(
                "Storage changed",
                { count: storage.length, id: "storage" },
                table(
                  [
                    { label: "Slot" },
                    { label: "First before", num: true },
                    { label: "Last after", num: true },
                    { label: "Txs", num: true },
                  ],
                  storage.map((slot) => ({
                    cells: [
                      h(
                        "span",
                        { class: cx("mono", !slot.hint && "faint"), title: slot.slot },
                        slot.hint ?? shortHex(slot.slot, 10, 6),
                      ),
                      h(
                        "span",
                        { class: "mono", title: slot.before },
                        formatInt(BigInt(slot.before)),
                      ),
                      h(
                        "span",
                        { class: "mono", title: slot.after },
                        formatInt(BigInt(slot.after)),
                      ),
                      h(
                        "span",
                        null,
                        slot.txs
                          .slice(0, 3)
                          .map((tx, i) => [i > 0 ? " " : null, txLink(idx, tx, `${i + 1}`)]),
                        slot.txs.length > 3 ? ` +${slot.txs.length - 3}` : null,
                      ),
                    ],
                  })),
                  { label: "Storage changed" },
                ),
              ),
        ),
        h(
          "div",
          { class: "stack" },
          panel(
            "Transactions",
            { count: related.length, id: "txs" },
            related.length === 0 ? empty("None.") : list.el,
          ),
        ),
      ),
    ],
  };
}
