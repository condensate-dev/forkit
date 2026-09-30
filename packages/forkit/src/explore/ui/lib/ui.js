// Shared pieces of the explorer's views: addresses, amounts, decoded values, chips and panels.

import { copyButton, cx, h, icon } from "./dom.js";
import { formatInt, formatUnits, shortHex } from "./format.js";
import { chainName, labelOf, route, SETUP, tokenInfo } from "./model.js";

export function link(href, ...children) {
  return h("a", { href }, ...children);
}

export function panel(title, options, ...body) {
  const { count, id, actions, className } = options ?? {};
  return h(
    "section",
    { class: cx("panel", className), id: id ?? null, "aria-labelledby": id ? `${id}-h` : null },
    h(
      "header",
      { class: "panel-head" },
      h(
        "h2",
        { id: id ? `${id}-h` : null },
        title,
        count === undefined ? null : h("span", { class: "count" }, formatInt(count)),
      ),
      actions ? h("div", { class: "panel-actions" }, actions) : null,
    ),
    ...body,
  );
}

export function empty(text) {
  return h("p", { class: "empty" }, text);
}

/** A table in its own horizontal scroll container, so the page never scrolls sideways. */
export function table(headers, rows, options = {}) {
  const cls = (header) => cx(header.num && "num", header.hideSm && "hide-sm", header.className);
  return h(
    "div",
    { class: "table-wrap", tabindex: "0", role: "region", "aria-label": options.label ?? null },
    h(
      "table",
      { class: cx(options.className) },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          headers.map((x) => h("th", { class: cls(x), scope: "col" }, x.label)),
        ),
      ),
      h(
        "tbody",
        null,
        rows.map((row) =>
          row.group !== undefined
            ? h(
                "tr",
                { class: "group" },
                h("th", { colspan: headers.length, scope: "rowgroup" }, row.group),
              )
            : h(
                "tr",
                { class: row.className ?? null },
                row.cells.map((cell, i) => h("td", { class: cls(headers[i]) }, cell)),
              ),
        ),
      ),
    ),
  );
}

/** A definition list of label/value rows. */
export function kv(rows) {
  return h(
    "dl",
    { class: "kv" },
    rows
      .filter(Boolean)
      .map(([k, v]) => h("div", { class: "kv-row" }, h("dt", null, k), h("dd", null, v))),
  );
}

export function statTile(label, value, sub, tone) {
  return h(
    "div",
    { class: cx("stat", tone && `stat-${tone}`) },
    h("span", { class: "stat-k" }, label),
    h("span", { class: "stat-v" }, value),
    sub ? h("span", { class: "stat-sub" }, sub) : null,
  );
}

/** A status, never by colour alone: an icon and a word. */
export function status(value) {
  const map = {
    pass: ["ok", "pass", "passed"],
    success: ["ok", "pass", "success"],
    fail: ["bad", "fail", "failed"],
    reverted: ["bad", "fail", "reverted"],
    running: ["warn", "dot", "running"],
  };
  const [tone, glyph, text] = map[value] ?? ["", "dot", value];
  return h(
    "span",
    { class: cx("status", tone && `is-${tone}`) },
    icon(glyph),
    h("span", null, text),
  );
}

/** A status icon with its word for screen readers only (dense lists). */
export function statusIcon(value) {
  const bad = value === "fail" || value === "reverted";
  const ok = value === "pass" || value === "success";
  return h(
    "span",
    { class: cx("status-icon", bad ? "is-bad" : ok ? "is-ok" : "is-warn"), title: value },
    icon(bad ? "fail" : ok ? "pass" : "dot"),
    h("span", { class: "sr" }, value),
  );
}

export function chainChip(idx, chainId) {
  return h("span", { class: "chip", title: `chain id ${chainId}` }, chainName(idx, chainId));
}

export function tag(text, kind) {
  return h("span", { class: cx("tag", kind && `tag-${kind}`) }, text);
}

export function hash(value, options = {}) {
  return h(
    "span",
    { class: "hashline" },
    h("span", { class: "mono hash", title: value }, options.short ? shortHex(value, 10, 8) : value),
    options.copy === false ? null : copyButton(value, options.what ?? "hash"),
  );
}

/** An address: its label when the run has one, linking to its address view. */
export function addr(idx, address, options = {}) {
  if (typeof address !== "string") return h("span", { class: "faint" }, "—");
  const lower = address.toLowerCase();
  const name = labelOf(idx, lower);
  const token = idx.tokenByAddress.get(lower);
  const shown = name ?? token?.symbol;
  const text = options.full ? lower : shortHex(lower);
  const anchor = h(
    "a",
    {
      class: cx("addr", shown && "is-named"),
      href: route(["run", idx.run.id, "address", lower]),
      title: shown ? `${shown} ${lower}` : lower,
    },
    shown ?? h("span", { class: "mono" }, text),
    shown && options.full ? h("span", { class: "mono faint" }, ` ${text}`) : null,
  );
  if (!options.copy) return anchor;
  return h("span", { class: "hashline" }, anchor, copyButton(lower, "address"));
}

/** A token amount, scaled by its decimals, with its symbol (linked to the token). */
export function amount(idx, chainId, token, raw, options = {}) {
  const info = tokenInfo(idx, chainId, token);
  const v = BigInt(raw);
  const text = info.decimals === undefined ? formatInt(raw) : formatUnits(raw, info.decimals);
  const signed = options.signed && v > 0n ? `+${text}` : text;
  const tone = options.signed ? (v > 0n ? "pos" : v < 0n ? "neg" : "") : "";
  const symbol =
    token === "native" || options.plain
      ? h("span", { class: "sym" }, info.symbol)
      : h(
          "a",
          { class: "sym", href: route(["run", idx.run.id, "address", token]), title: token },
          info.symbol,
        );
  return h(
    "span",
    { class: cx("amount", tone), title: `${raw} (raw)` },
    h("span", { class: "num-v" }, signed),
    " ",
    symbol,
  );
}

export function txLink(idx, tx, text) {
  return link(
    route(["run", idx.run.id, "tx", tx.id]),
    text ?? h("span", { class: "mono" }, tx.hash ? shortHex(tx.hash, 10, 6) : "not mined"),
  );
}

export function testLink(idx, key) {
  if (key === undefined || key === SETUP)
    return link(route(["run", idx.run.id, "test", SETUP]), "setup & teardown");
  const test = idx.tests.get(key);
  return link(route(["run", idx.run.id, "test", key]), test ? test.name : key);
}

// ---------------------------------------------------------------------------------------------
// Decoded values

function isPaddedAddress(hex) {
  return /^0x0{24}[0-9a-f]{40}$/i.test(hex) && !/^0x0{64}$/i.test(hex);
}

/** One decoded ABI value, rendered by its Solidity type. */
export function value(idx, type, v, options = {}) {
  const array = /^(.*)\[(\d*)\]$/.exec(type);
  if (array !== null && Array.isArray(v)) {
    if (v.length === 0) return h("span", { class: "faint" }, "[]");
    return h(
      "span",
      null,
      "[",
      v.map((item, i) => [i > 0 ? ", " : null, value(idx, array[1], item, options)]),
      "]",
    );
  }
  if (type === "tuple" && Array.isArray(v)) {
    if (options.inline) return h("span", { class: "faint", title: "tuple" }, "{…}");
    return h(
      "span",
      { class: "tuple" },
      "{ ",
      v.map((p, i) => [
        i > 0 ? ", " : null,
        h("span", { class: "arg-name" }, `${p.name || i}: `),
        value(idx, p.type, p.value, options),
      ]),
      " }",
    );
  }
  if (type === "address") return addr(idx, v);
  if (type === "bool") return h("span", { class: "mono" }, String(v));
  if (/^u?int\d*$/.test(type)) return h("span", { class: "mono", title: String(v) }, formatInt(v));
  if (type === "bytes32" && typeof v === "string" && isPaddedAddress(v)) {
    return h("span", { title: v }, addr(idx, `0x${v.slice(26)}`));
  }
  if (type.startsWith("bytes") && typeof v === "string") {
    const max = options.inline ? 18 : 74;
    return h(
      "span",
      { class: "mono", title: v },
      v.length > max
        ? `${v.slice(0, max - 8)}…${options.inline ? "" : ` (${(v.length - 2) / 2} bytes)`}`
        : v,
    );
  }
  if (type === "string") return h("span", { class: "mono str" }, JSON.stringify(v));
  return h("span", { class: "mono" }, typeof v === "string" ? v : JSON.stringify(v));
}

/** `target.name(arg: v, …)` on one line. */
export function inlineCall(idx, call, target) {
  return h(
    "span",
    { class: "call" },
    target ?? null,
    target ? "." : null,
    h("span", { class: "fn" }, call.name),
    "(",
    call.args.map((arg, i) => [
      i > 0 ? ", " : null,
      arg.name ? h("span", { class: "arg-name" }, `${arg.name}: `) : null,
      value(idx, arg.type, arg.value, { inline: true }),
    ]),
    ")",
  );
}

/** A table of decoded parameters: name, type, value. */
export function paramsTable(idx, params) {
  return h(
    "div",
    { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Parameters" },
    h(
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
              "th",
              { scope: "row" },
              h("span", { class: "mono" }, p.name || `[${i}]`),
              h("span", { class: "ty" }, p.type),
            ),
            h("td", null, value(idx, p.type, p.value)),
          ),
        ),
      ),
    ),
  );
}

/** Raw hex in a scroll box, with a copy button. */
export function rawBox(label, text, open = false) {
  return h(
    "details",
    { class: "raw", open },
    h("summary", null, icon("chevron"), label),
    h(
      "div",
      { class: "raw-body" },
      h("pre", { class: "box" }, text),
      copyButton(text, label.toLowerCase()),
    ),
  );
}
