// The run list and a run's overview: failures first, tests, transactions, forks and fills.

import { cx, h, icon, rowList, setActiveNav } from "../lib/dom.js";
import {
  compact,
  formatInt,
  formatMs,
  formatTime,
  formatUnits,
  shortHex,
  shortUrl,
} from "../lib/format.js";
import {
  bridgeFee,
  diffStrings,
  route,
  runTotals,
  SETUP,
  testStats,
  testsFailuresFirst,
} from "../lib/model.js";
import {
  addr,
  amount,
  chainChip,
  empty,
  link,
  panel,
  statTile,
  status,
  statusIcon,
  table,
  tag,
  testLink,
  txLink,
} from "../lib/ui.js";

export function viewRuns(runs, go) {
  const list = rowList({
    items: runs,
    label: "Runs",
    rowHeight: 56,
    className: "runs-list",
    onActivate: (r) => go(route(["run", r.id])),
    render: (r) =>
      h(
        "div",
        { class: "run-row" },
        statusIcon(r.failed > 0 ? "fail" : "pass"),
        h(
          "div",
          { class: "run-main" },
          link(route(["run", r.id]), h("span", { class: "mono" }, r.id)),
          h(
            "span",
            { class: "faint" },
            `${formatTime(r.startedAt)} · ${formatMs(r.updatedAt - r.startedAt)}`,
          ),
        ),
        h(
          "div",
          { class: "run-meta" },
          r.failed > 0
            ? h("span", { class: "neg" }, `${r.failed} failed`)
            : h("span", null, `${r.passed} passed`),
          h("span", { class: "faint" }, ` · ${formatInt(r.tests)} tests · ${formatInt(r.txs)} txs`),
          h(
            "span",
            { class: "chips hide-sm" },
            r.chains.map((c) => h("span", { class: "chip" }, c.chainName)),
          ),
        ),
      ),
  });
  setActiveNav(list);
  return {
    title: "Runs",
    crumbs: [{ text: "Runs" }],
    body: [
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
              null,
              "Record one with ",
              h("code", null, "FORKIT_RECORD=1"),
              " in front of your test command, then reload.",
            ),
          )
        : h("section", { class: "panel" }, list.el),
    ],
  };
}

/** Expected vs actual, with the differing characters marked. */
export function expectation(test) {
  if (test.expected === undefined && test.actual === undefined) return null;
  const multi = `${test.expected}${test.actual}`.includes("\n");
  if (multi) return null; // Rendered as a line diff by the test view.
  const d = diffStrings(test.expected ?? "", test.actual ?? "");
  const line = (label, part, cls) =>
    h(
      "div",
      { class: cx("exp-line", cls) },
      h("span", { class: "exp-k" }, label),
      h("code", null, part.same0, part.diff ? h("mark", null, part.diff) : null, part.same1),
    );
  return h(
    "div",
    { class: "expect" },
    line("Expected", d.expected, "is-exp"),
    line("Actual", d.actual, "is-act"),
  );
}

function failureCard(idx, test) {
  const txs = idx.txsByTest.get(test.key) ?? [];
  const reverted = txs.filter((t) => t.status === "reverted");
  return h(
    "article",
    { class: "failure" },
    h(
      "header",
      null,
      statusIcon("fail"),
      h("h3", null, link(route(["run", idx.run.id, "test", test.key]), test.name)),
      h("span", { class: "faint" }, test.suite),
    ),
    test.error ? h("pre", { class: "err" }, test.error.split("\n").slice(0, 6).join("\n")) : null,
    expectation(test),
    reverted.length > 0
      ? h(
          "p",
          { class: "small" },
          `${reverted.length} reverted transaction${reverted.length > 1 ? "s" : ""}: `,
          reverted
            .slice(0, 3)
            .map((tx, i) => [i > 0 ? ", " : null, txLink(idx, tx, tx.call?.name ?? "tx")]),
        )
      : null,
  );
}

/** Deposit and fill, side by side, with the fee the bridge took. */
export function fillRoute(idx, linked) {
  const { fill, deposit, fillTxs } = linked;
  const fee = bridgeFee(linked);
  const leg = (chainId, title, body) =>
    h(
      "div",
      { class: "leg" },
      h("div", { class: "leg-head" }, h("strong", null, title), chainChip(idx, chainId)),
      body,
    );
  const txLine = (tx, hashText) =>
    h(
      "div",
      { class: "leg-tx" },
      tx
        ? [statusIcon(tx.status), " ", txLink(idx, tx, tx.call?.name ?? shortHex(tx.hash, 10, 6))]
        : h("span", { class: "mono" }, shortHex(hashText, 10, 6)),
      tx?.hash ? h("span", { class: "mono faint" }, ` ${shortHex(tx.hash, 8, 4)}`) : null,
    );
  const inAmount =
    fee.input !== undefined && fee.inputToken
      ? amount(idx, fill.originChainId, fee.inputToken, fee.input)
      : fee.input !== undefined
        ? h("span", { class: "mono" }, formatInt(fee.input))
        : null;
  const outAmount =
    fill.outputAmount !== undefined && fee.outputToken
      ? amount(idx, fill.destinationChainId, fee.outputToken, fill.outputAmount)
      : fill.outputAmount !== undefined
        ? h("span", { class: "mono" }, formatInt(fill.outputAmount))
        : null;
  const feeToken = fee.inputToken ?? fee.outputToken;
  const feeChain = fee.inputToken ? fill.originChainId : fill.destinationChainId;
  const feeText =
    fee.fee === undefined
      ? null
      : feeToken
        ? amount(idx, feeChain, feeToken, fee.fee)
        : h("span", { class: "mono" }, formatInt(fee.fee));
  const feePct =
    fee.fee !== undefined && fee.input !== undefined && BigInt(fee.input) > 0n
      ? `${((Number(fee.fee) / Number(fee.input)) * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`
      : null;
  return h(
    "div",
    { class: "route" },
    leg(fill.originChainId, "Deposit", [
      deposit ? txLine(deposit) : txLine(undefined, fill.depositTxHash),
      inAmount ? h("div", { class: "leg-amt" }, "in ", inAmount) : null,
    ]),
    h(
      "div",
      { class: "route-mid", "aria-hidden": "true" },
      icon("arrow"),
      h("span", { class: "route-bridge" }, fill.bridge),
    ),
    leg(fill.destinationChainId, "Fill", [
      fillTxs.length === 0
        ? empty("no transaction")
        : fillTxs.map(({ hash, tx }) => txLine(tx, hash)),
      outAmount ? h("div", { class: "leg-amt" }, "out ", outAmount) : null,
    ]),
    h(
      "div",
      { class: "route-foot" },
      h("span", { class: "sr" }, `${fill.bridge} bridge. `),
      feeText
        ? [
            h("span", { class: "k" }, "Fee "),
            feeText,
            feePct ? h("span", { class: "faint" }, ` (${feePct})`) : null,
          ]
        : null,
      fill.test ? h("span", { class: "faint" }, [" · in ", testLink(idx, fill.test)]) : null,
    ),
  );
}

/** Transactions as navigable rows: status, call, target, chain, gas, test. */
export function txRows(idx, txs, go, options = {}) {
  return rowList({
    items: txs,
    label: options.label ?? "Transactions",
    rowHeight: 48,
    className: "tx-list",
    onActivate: (tx) => go(route(["run", idx.run.id, "tx", tx.id])),
    render: (tx) =>
      h(
        "div",
        { class: "tx-row" },
        statusIcon(tx.status),
        h(
          "div",
          { class: "tx-main" },
          h(
            "div",
            { class: "line" },
            txLink(
              idx,
              tx,
              h(
                "span",
                { class: "fn" },
                tx.call?.name ??
                  tx.functionName ??
                  (tx.kind === "deployContract" ? "deploy" : "transfer"),
              ),
            ),
            tx.to ? [h("span", { class: "faint" }, " → "), addr(idx, tx.to)] : null,
          ),
          h(
            "div",
            { class: "line sub" },
            tx.status === "reverted" && tx.revert
              ? h("span", { class: "neg" }, tx.revert)
              : [h("span", { class: "faint" }, "from "), addr(idx, tx.from)],
          ),
        ),
        h(
          "div",
          { class: "tx-side" },
          chainChip(idx, tx.chainId),
          h("span", { class: "gas mono" }, tx.gasUsed ? compact(tx.gasUsed) : "—"),
        ),
        options.withTest ? h("div", { class: "tx-test hide-sm" }, testLink(idx, tx.test)) : null,
      ),
  });
}

export function viewRun(idx, go) {
  const { run } = idx;
  const t = runTotals(idx);
  const failures = run.tests.filter((x) => x.status === "fail");

  const tests = testsFailuresFirst(run);
  const setup = testStats(idx, SETUP);
  const setupDeals = (idx.dealsByTest.get(SETUP) ?? []).length;
  const items = [
    ...tests,
    ...(setup.txs > 0 || setupDeals > 0
      ? [{ key: SETUP, name: "Setup & teardown", suite: "outside tests", status: "setup" }]
      : []),
  ];
  const testList = rowList({
    items,
    label: "Tests",
    rowHeight: 48,
    className: "test-list",
    onActivate: (test) => go(route(["run", run.id, "test", test.key])),
    render: (test) => {
      const st = testStats(idx, test.key);
      return h(
        "div",
        { class: "test-row" },
        test.status === "setup"
          ? h("span", { class: "status-icon" }, icon("dot"))
          : statusIcon(test.status),
        h(
          "div",
          { class: "test-main" },
          h("div", { class: "line" }, link(route(["run", run.id, "test", test.key]), test.name)),
          h("div", { class: "line sub faint" }, test.suite),
        ),
        h(
          "div",
          { class: "test-nums" },
          h("span", { title: "transactions" }, `${formatInt(st.txs)} tx`),
          st.reverts > 0 ? h("span", { class: "neg" }, `${st.reverts} reverted`) : null,
          h(
            "span",
            { class: "hide-sm mono", title: "gas used" },
            st.gas > 0n ? `${compact(st.gas)} gas` : "",
          ),
          h("span", { class: "faint" }, formatMs(test.durationMs)),
        ),
      );
    },
  });
  setActiveNav(testList);

  const txList = txRows(idx, run.txs, go, { withTest: true });

  const forkRows = run.forks.map((f) => ({
    cells: [
      h(
        "span",
        null,
        h("strong", null, f.chainName),
        h("span", { class: "faint" }, ` ${f.chainId}`),
      ),
      f.blockNumber === undefined
        ? h("span", { class: "tag tag-warn" }, "live head")
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

  const side = [
    panel(
      "Forks",
      { count: run.forks.length, id: "forks" },
      run.forks.length === 0
        ? empty("No forks booted.")
        : table(
            [
              { label: "Chain" },
              { label: "Block", num: true },
              { label: "Cache", num: true },
              { label: "Boot", num: true },
            ],
            forkRows,
            { label: "Forks" },
          ),
    ),
    panel(
      "Cross-chain",
      { count: run.fills.length, id: "fills" },
      idx.fills.length === 0
        ? empty("No bridge fills in this run.")
        : idx.fills.map((linked) => fillRoute(idx, linked)),
    ),
    run.gas.length === 0
      ? null
      : panel(
          "Gas snapshots",
          { count: run.gas.length, id: "gas" },
          table(
            [{ label: "Label" }, { label: "Gas", num: true }, { label: "Δ", num: true }],
            run.gas.map((g) => {
              const delta =
                g.previous === undefined ? undefined : BigInt(g.gas) - BigInt(g.previous);
              return {
                cells: [
                  h("span", { class: "mono" }, g.label),
                  h("span", { class: "mono" }, formatInt(g.gas)),
                  delta === undefined
                    ? h("span", { class: "faint" }, "new")
                    : h(
                        "span",
                        { class: delta > 0n ? "neg" : delta < 0n ? "pos" : "faint" },
                        delta > 0n ? `+${formatInt(delta)}` : formatInt(delta),
                      ),
                ],
              };
            }),
            { label: "Gas snapshots" },
          ),
        ),
    labelled.length === 0
      ? null
      : panel(
          "Labels",
          { count: labelled.length, id: "labels" },
          table(
            [{ label: "Label" }, { label: "Address" }],
            labelled.map(([address, name]) => ({
              cells: [
                link(route(["run", run.id, "address", address]), name),
                h("span", { class: "mono faint" }, shortHex(address, 8, 6)),
              ],
            })),
            { label: "Labels" },
          ),
        ),
    run.http.length === 0
      ? null
      : panel(
          "HTTP replay",
          { count: run.http.length, id: "http" },
          table(
            [{ label: "Request" }, { label: "Outcome" }],
            run.http.map((r) => ({
              cells: [
                h("span", { class: "mono", title: r.url }, `${r.method} ${shortUrl(r.url)}`),
                tag(r.outcome, r.outcome === "unmatched" ? "bad" : r.outcome === "hit" ? "ok" : ""),
              ],
            })),
            { label: "HTTP replay" },
          ),
        ),
  ];

  const native = run.forks[0]?.nativeSymbol ?? "ETH";
  return {
    title: run.id,
    crumbs: [{ text: "Runs", href: "#/" }, { text: run.id }],
    body: [
      h(
        "div",
        { class: "page-head" },
        h("h1", { class: "mono" }, run.id),
        t.failed > 0 ? status("fail") : t.running > 0 ? status("running") : status("pass"),
        h("span", { class: "sub" }, `${formatTime(run.startedAt)} · ${formatMs(t.durationMs)}`),
      ),
      h(
        "div",
        { class: "stats" },
        statTile(
          "Tests",
          formatInt(t.tests),
          t.failed > 0 ? `${t.failed} failed · ${t.passed} passed` : `${t.passed} passed`,
          t.failed > 0 ? "bad" : null,
        ),
        statTile(
          "Transactions",
          formatInt(t.txs),
          t.reverted > 0 ? `${t.reverted} reverted` : "none reverted",
        ),
        statTile(
          "Gas used",
          compact(t.gas),
          t.fees > 0n ? `${formatUnits(t.fees.toString(), 18, 6)} ${native} in fees` : null,
        ),
        statTile(
          "Forks",
          formatInt(t.forks),
          `${t.chains} chain${t.chains === 1 ? "" : "s"} · ${t.blocks} blocks`,
        ),
        statTile("Cheats", formatInt(t.cheats), "deal, prank, warp, …"),
        statTile("Fills", formatInt(t.fills), t.fills > 0 ? "cross-chain" : null),
      ),
      failures.length === 0
        ? null
        : panel(
            "Failures",
            { count: failures.length, id: "failures", className: "is-bad" },
            h(
              "div",
              { class: "failures" },
              failures.map((f) => failureCard(idx, f)),
            ),
          ),
      h(
        "div",
        { class: "grid" },
        h(
          "div",
          { class: "stack" },
          panel(
            "Tests",
            { count: run.tests.length, id: "tests" },
            items.length === 0 ? empty("No itFork tests in this run.") : testList.el,
          ),
          run.txs.length === 0
            ? null
            : panel("Transactions", { count: run.txs.length, id: "txs" }, txList.el),
        ),
        h("div", { class: "stack" }, side),
      ),
    ],
  };
}
