// One test: its timeline (every transaction and cheatcode in order, the failed assertion last),
// the failure with expected vs actual, and what it did to balances.

import { cx, h, icon, rowList, setActiveNav } from "../lib/dom.js";
import {
  compact,
  formatInt,
  formatMs,
  formatOffset,
  formatSeconds,
  formatUnix,
  percent,
  shortHex,
  shortUrl,
} from "../lib/format.js";
import {
  chainName,
  diffLines,
  labelOf,
  netChanges,
  route,
  SETUP,
  testStats,
  timeline,
} from "../lib/model.js";
import {
  addr,
  amount,
  chainChip,
  empty,
  inlineCall,
  panel,
  statTile,
  status,
  table,
  tag,
  txLink,
} from "../lib/ui.js";
import { expectation, fillRoute } from "./run.js";

function stepRow(idx, start, item) {
  const row = (tagText, kind, what, meta) =>
    h(
      "div",
      { class: cx("step", `step-${kind}`) },
      h("span", { class: "step-t mono" }, formatOffset(item.ts - start)),
      h("span", { class: "step-tag" }, tag(tagText, kind)),
      h("div", { class: "step-what" }, what),
      h("div", { class: "step-meta" }, meta),
    );
  const v = item.value;
  switch (item.kind) {
    case "tx": {
      const target = v.to ? addr(idx, v.to) : h("span", { class: "faint" }, "new contract");
      const what = v.call
        ? inlineCall(idx, v.call, target)
        : v.kind === "deployContract"
          ? h(
              "span",
              null,
              "deploy ",
              v.contractAddress ? addr(idx, v.contractAddress) : "contract",
            )
          : h(
              "span",
              { class: "call" },
              target,
              v.data && v.data !== "0x"
                ? h("span", { class: "faint" }, `.${v.data.slice(0, 10)}(…)`)
                : h("span", { class: "faint" }, " (transfer)"),
            );
      const reverted = v.status === "reverted";
      return row(
        reverted ? "revert" : "tx",
        reverted ? "bad" : "tx",
        [
          h("div", { class: "line" }, what),
          h(
            "div",
            { class: "line sub" },
            item.as
              ? [h("span", { class: "faint" }, "as "), addr(idx, item.as), " · "]
              : [h("span", { class: "faint" }, "from "), addr(idx, v.from), " · "],
            txLink(idx, v),
            reverted && v.revert ? [" · ", h("span", { class: "neg" }, v.revert)] : null,
          ),
        ],
        [
          chainChip(idx, v.chainId),
          v.gasUsed ? h("span", { class: "mono gas" }, `${compact(v.gasUsed)} gas`) : null,
        ],
      );
    }
    case "deal":
      return row(
        "deal",
        "cheat",
        h(
          "div",
          { class: "line" },
          "set ",
          addr(idx, v.holder),
          " balance to ",
          amount(idx, v.chainId, v.token, v.amount),
        ),
        chainChip(idx, v.chainId),
      );
    case "cheat": {
      const text = {
        prank: () => [
          "as ",
          addr(idx, v.account),
          h("span", { class: "faint" }, " from here (impersonating)"),
        ],
        stopPrank: () => ["stop acting as ", addr(idx, v.account)],
        warp: () => [
          "time +",
          h("strong", null, formatSeconds(v.seconds ?? 0)),
          v.timestamp ? h("span", { class: "faint" }, ` → ${formatUnix(v.timestamp)}`) : null,
        ],
        roll: () => [
          "mine ",
          h("strong", null, formatInt(v.blocks ?? 0)),
          " blocks",
          v.blockNumber ? h("span", { class: "faint" }, ` → #${formatInt(v.blockNumber)}`) : null,
        ],
        snapshot: () => ["snapshot ", h("span", { class: "mono" }, v.snapshotId ?? "")],
        revert: () => [
          "revert to snapshot ",
          h("span", { class: "mono" }, v.snapshotId ?? ""),
          h("span", { class: "faint" }, " (undoes what came after it)"),
        ],
      }[v.cheat];
      const label =
        {
          prank: "prank",
          stopPrank: "stop prank",
          warp: "warp",
          roll: "roll",
          snapshot: "snapshot",
          revert: "revert to",
        }[v.cheat] ?? v.cheat;
      return row(
        label,
        "cheat",
        h("div", { class: "line" }, text ? text() : v.cheat),
        chainChip(idx, v.chainId),
      );
    }
    case "fill": {
      const linked = idx.fills.find((f) => f.fill === v);
      return row(
        "fill",
        "fill",
        [
          h(
            "div",
            { class: "line" },
            h("strong", null, v.bridge),
            ` ${chainName(idx, v.originChainId)} → ${chainName(idx, v.destinationChainId)}`,
          ),
          h(
            "div",
            { class: "line sub" },
            "deposit ",
            linked?.deposit
              ? txLink(idx, linked.deposit)
              : h("span", { class: "mono" }, shortHex(v.depositTxHash, 10, 6)),
            " filled by ",
            (linked?.fillTxs ?? []).map(({ hash, tx }, i) => [
              i > 0 ? ", " : null,
              tx ? txLink(idx, tx) : h("span", { class: "mono" }, shortHex(hash, 10, 6)),
            ]),
          ),
        ],
        null,
      );
    }
    case "http":
      return row(
        "http",
        "http",
        h(
          "div",
          { class: "line" },
          h("span", { class: "mono", title: v.url }, `${v.method} ${shortUrl(v.url)}`),
        ),
        tag(v.outcome, v.outcome === "unmatched" ? "bad" : v.outcome === "hit" ? "ok" : ""),
      );
    case "gas":
      return row(
        "gas",
        "gas",
        h("div", { class: "line" }, "snapshot ", h("span", { class: "mono" }, v.label)),
        h("span", { class: "mono gas" }, `${formatInt(v.gas)} gas`),
      );
    case "assert":
      return row(
        "assert",
        "bad",
        [
          h("div", { class: "line neg" }, icon("fail"), " ", (v.error ?? "failed").split("\n")[0]),
          v.expected !== undefined || v.actual !== undefined
            ? h(
                "div",
                { class: "line sub" },
                h("span", { class: "faint" }, "expected "),
                h("code", null, oneLine(v.expected)),
                h("span", { class: "faint" }, " · actual "),
                h("code", null, oneLine(v.actual)),
              )
            : null,
        ],
        null,
      );
  }
  return h("div", null);
}

const oneLine = (text) => {
  const s = String(text ?? "").replace(/\s+/g, " ");
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

function failure(test) {
  const multi = `${test.expected ?? ""}${test.actual ?? ""}`.includes("\n");
  return h(
    "section",
    { class: "callout is-bad", id: "failure" },
    h("h2", null, icon("fail"), " Assertion failed"),
    h("pre", { class: "err" }, test.error ?? "failed"),
    multi
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "pre",
            { class: "linediff", "aria-label": "Expected (−) versus actual (+)" },
            diffLines(test.expected ?? "", test.actual ?? "").map((l) =>
              h(
                "span",
                { class: cx("ld", l.op === "-" ? "is-exp" : l.op === "+" ? "is-act" : null) },
                `${l.op === " " ? " " : l.op} ${l.text}\n`,
              ),
            ),
          ),
        )
      : expectation(test),
  );
}

/** Horizontal bars: gas per mined transaction, largest first. */
function gasBars(idx, txs) {
  const mined = txs
    .filter((t) => t.gasUsed !== undefined)
    .sort((a, b) => Number(BigInt(b.gasUsed) - BigInt(a.gasUsed)));
  if (mined.length === 0) return empty("No gas used.");
  const max = Number(mined[0].gasUsed);
  const total = mined.reduce((s, t) => s + Number(t.gasUsed), 0);
  return h(
    "ol",
    { class: "bars", "aria-label": "Gas by transaction" },
    mined.slice(0, 12).map((tx) => {
      const bar = h("span", { class: cx("bar", tx.status === "reverted" && "is-bad") });
      bar.style.width = `${Math.max(1, (Number(tx.gasUsed) / max) * 100)}%`;
      return h(
        "li",
        null,
        h("span", { class: "bar-k" }, txLink(idx, tx, tx.call?.name ?? tx.kind)),
        h("span", { class: "bar-track" }, bar),
        h(
          "span",
          {
            class: "bar-v mono",
            title: `${formatInt(tx.gasUsed)} gas, ${percent(tx.gasUsed, total)} of the test`,
          },
          compact(tx.gasUsed),
        ),
      );
    }),
  );
}

export function viewTest(idx, key, ctx) {
  const { run } = idx;
  const test = key === SETUP ? undefined : idx.tests.get(key);
  if (key !== SETUP && test === undefined) return undefined;
  const title = test ? test.name : "Setup & teardown";
  const items = timeline(idx, key);
  const start = test?.startedAt ?? items[0]?.ts ?? run.startedAt;
  const txs = idx.txsByTest.get(key) ?? [];
  const st = testStats(idx, key);
  const net = netChanges(txs);
  const chains = new Set([
    ...txs.map((t) => t.chainId),
    ...(idx.dealsByTest.get(key) ?? []).map((d) => d.chainId),
  ]);
  const cheats = items.filter((i) => i.kind === "cheat" || i.kind === "deal").length;

  const initial = Number(ctx.params.get("step") ?? -1);
  const steps = rowList({
    items,
    label: "Timeline",
    rowHeight: 56,
    className: "steps",
    selected:
      Number.isInteger(initial) && initial >= 0 && initial < items.length ? initial : undefined,
    onSelect: (_item, i) => ctx.setParams({ step: i }),
    onActivate: (item) => {
      if (item.kind === "tx") ctx.go(route(["run", run.id, "tx", item.value.id]));
      else if (item.kind === "assert")
        document.getElementById("failure")?.scrollIntoView({ block: "start" });
      else if (item.kind === "deal") ctx.go(route(["run", run.id, "address", item.value.holder]));
      else if (item.kind === "cheat" && item.value.account)
        ctx.go(route(["run", run.id, "address", item.value.account]));
    },
    render: (item) => stepRow(idx, start, item),
  });
  setActiveNav(steps);
  if (steps.selected >= 0)
    requestAnimationFrame(() => steps.select(steps.selected, { silent: true }));

  const sorted = [...net].sort((a, b) => {
    const la = labelOf(idx, a.address) ?? a.address;
    const lb = labelOf(idx, b.address) ?? b.address;
    return la.localeCompare(lb) || a.token.localeCompare(b.token);
  });

  const linked = idx.fills.filter(
    (f) => f.fill.test === key || (key === SETUP && f.fill.test === undefined),
  );

  return {
    title,
    crumbs: [
      { text: "Runs", href: "#/" },
      { text: run.id, href: route(["run", run.id]) },
      { text: title },
    ],
    body: [
      h(
        "div",
        { class: "page-head" },
        h("h1", null, title),
        test ? status(test.status) : null,
        h(
          "span",
          { class: "sub" },
          test
            ? `${test.suite} · ${formatMs(test.durationMs)}`
            : "transactions outside any itFork test (hooks)",
        ),
      ),
      test?.status === "fail" ? failure(test) : null,
      h(
        "div",
        { class: "stats" },
        statTile(
          "Transactions",
          formatInt(st.txs),
          st.reverts > 0 ? `${st.reverts} reverted` : null,
          st.reverts > 0 ? "bad" : null,
        ),
        statTile("Gas used", compact(st.gas), st.gas > 0n ? `${formatInt(st.gas)} gas` : null),
        statTile("Cheats", formatInt(cheats), "deals, pranks, warps"),
        statTile(
          "Chains",
          formatInt(chains.size),
          [...chains].map((c) => chainName(idx, c)).join(", "),
        ),
      ),
      h(
        "div",
        { class: "grid" },
        h(
          "div",
          { class: "stack" },
          panel(
            "Timeline",
            {
              count: items.length,
              id: "timeline",
              actions: h(
                "span",
                { class: "hint hide-sm" },
                h("kbd", null, "j"),
                h("kbd", null, "k"),
                " step · ",
                h("kbd", null, "↵"),
                " open",
              ),
            },
            items.length === 0 ? empty("Nothing recorded in this test.") : steps.el,
          ),
        ),
        h(
          "div",
          { class: "stack" },
          linked.length > 0
            ? panel(
                "Cross-chain",
                { count: linked.length, id: "fills" },
                linked.map((l) => fillRoute(idx, l)),
              )
            : null,
          panel(
            "Balance changes",
            { count: net.length, id: "balances" },
            net.length === 0
              ? empty("No balance changes.")
              : table(
                  [{ label: "Holder" }, { label: "Net change", num: true }],
                  sorted.map((c) => ({
                    cells: [
                      h(
                        "span",
                        { class: "holder" },
                        addr(idx, c.address),
                        chains.size > 1 ? chainChip(idx, c.chainId) : null,
                      ),
                      amount(idx, c.chainId, c.token, c.delta, { signed: true }),
                    ],
                  })),
                  { label: "Balance changes" },
                ),
          ),
          panel("Gas by transaction", { id: "gasbars" }, gasBars(idx, txs)),
        ),
      ),
    ],
  };
}
