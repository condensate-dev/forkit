// DOM helpers. Every string from a run record goes in as a text node or an attribute value, never
// as HTML; styles are set through the CSSOM (element.style), which the page's CSP allows.

const SVG_NS = "http://www.w3.org/2000/svg";

/** Build an element. `attrs` values: strings, booleans, or event handlers (`on*`). */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

/** Build an SVG element. */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

function setAttrs(el, attrs) {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else if (key === "class") {
      el.setAttribute("class", value);
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
}

export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === undefined || child === null || child === false || child === "") continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function cx(...names) {
  return names.filter(Boolean).join(" ") || null;
}

// ---------------------------------------------------------------------------------------------
// Icons: 16px strokes, currentColor.

const ICONS = {
  copy: ["M5.5 5.5h7v7h-7z", "M3.5 10.5v-7h7"],
  check: ["M3.5 8.5l3 3 6-7"],
  chevron: ["M6 4l4 4-4 4"],
  arrow: ["M3 8h10", "M9.5 4.5L13 8l-3.5 3.5"],
  fail: [
    "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5z",
    "M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5",
  ],
  pass: ["M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5z", "M5.25 8.25l1.9 1.9 3.6-4.1"],
  dot: ["M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"],
  code: ["M5.5 4.5L2 8l3.5 3.5", "M10.5 4.5L14 8l-3.5 3.5"],
  search: ["M7 2.75a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5z", "M10.25 10.25L13.5 13.5"],
  keyboard: ["M1.75 4.25h12.5v7.5H1.75z", "M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.25h6"],
  link: [
    "M6.5 9.5l3-3",
    "M7.25 4.75l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1",
    "M8.75 11.25l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1",
  ],
  bridge: ["M1.75 11.5h12.5", "M3 11.5V8a5 5 0 0 1 10 0v3.5"],
};

export function icon(name, label) {
  return s(
    "svg",
    {
      class: `icon icon-${name}`,
      viewBox: "0 0 16 16",
      width: 16,
      height: 16,
      "aria-hidden": label ? null : "true",
      role: label ? "img" : null,
      "aria-label": label ?? null,
    },
    (ICONS[name] ?? []).map((d) => s("path", { d })),
  );
}

// ---------------------------------------------------------------------------------------------
// Copy

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard API (or no permission): copy a selection instead.
    const area = h("textarea", { class: "offscreen", readonly: true, "aria-hidden": "true" });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** A small button that copies `text` and says so. */
export function copyButton(text, what = "value") {
  const label = `Copy ${what}`;
  const button = h(
    "button",
    {
      type: "button",
      class: "copy",
      title: label,
      "aria-label": label,
      onclick: async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const ok = await writeClipboard(text);
        button.replaceChildren(icon(ok ? "check" : "copy"));
        button.classList.toggle("is-done", ok);
        announce(ok ? `Copied ${what}` : `Could not copy ${what}`);
        setTimeout(() => {
          button.replaceChildren(icon("copy"));
          button.classList.remove("is-done");
        }, 1200);
      },
    },
    icon("copy"),
  );
  return button;
}

/** A labelled button that copies a longer text (a snippet). */
export function copyTextButton(text, label) {
  const button = h(
    "button",
    {
      type: "button",
      class: "btn",
      onclick: async () => {
        const ok = await writeClipboard(text);
        button.replaceChildren(icon(ok ? "check" : "copy"), ok ? "Copied" : "Copy failed");
        announce(ok ? "Copied" : "Could not copy");
        setTimeout(() => button.replaceChildren(icon("copy"), label), 1400);
      },
    },
    icon("copy"),
    label,
  );
  return button;
}

let live;
/** Say something to screen readers (copy confirmations, search results). */
export function announce(text) {
  live ??= document.getElementById("live");
  if (live) {
    live.textContent = "";
    setTimeout(() => {
      live.textContent = text;
    }, 30);
  }
}

// ---------------------------------------------------------------------------------------------
// Tooltip: one floating element, for the icicle and charts.

let tip;
export function showTip(content, x, y) {
  tip ??= document.getElementById("tip");
  if (!tip) return;
  tip.replaceChildren(...[content].flat());
  tip.hidden = false;
  const pad = 12;
  const { innerWidth: w, innerHeight: hgt } = window;
  const rect = tip.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > w - 8) left = Math.max(8, x - rect.width - pad);
  if (top + rect.height > hgt - 8) top = Math.max(8, y - rect.height - pad);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

export function hideTip() {
  tip ??= document.getElementById("tip");
  if (tip) tip.hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Lists: virtualised when long, and the target of j/k.

let activeList;

/** The list j/k move through on this page. */
export function activeNav() {
  return activeList?.el.isConnected ? activeList : undefined;
}

export function setActiveNav(list) {
  activeList = list;
}

/**
 * A list of rows. Up to `threshold` rows render in place; more render in their own scroll
 * container, only the rows in view (fixed `rowHeight`), so a run with thousands of transactions
 * stays fast. Rows are selectable: click, or j/k when the list is the page's active one.
 */
export function rowList({
  items,
  render,
  rowHeight = 40,
  threshold = 150,
  maxHeight = 640,
  label,
  className,
  selected,
  onSelect,
  onActivate,
}) {
  const virtual = items.length > threshold;
  const el = h("div", {
    class: cx("rows", virtual && "is-virtual", className),
    role: "listbox",
    "aria-label": label,
    tabindex: "0",
  });
  const rows = new Map();
  let current = selected ?? -1;
  const list = {
    el,
    items,
    get selected() {
      return current;
    },
    select,
    activate() {
      if (current >= 0) onActivate?.(items[current], current);
    },
    count: items.length,
  };

  const makeRow = (i) => {
    const row = render(items[i], i);
    row.classList.add("row");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === current));
    row.dataset.index = String(i);
    if (i === current) row.classList.add("is-selected");
    return row;
  };

  el.addEventListener("click", (event) => {
    const row = event.target.closest?.(".row");
    if (!row || !el.contains(row)) return;
    const i = Number(row.dataset.index);
    if (event.target.closest("a, button")) {
      select(i, { scroll: false, silent: true });
      return;
    }
    select(i, { scroll: false });
  });

  let inner;
  let paint;
  if (!virtual) {
    for (let i = 0; i < items.length; i++) {
      const row = makeRow(i);
      rows.set(i, row);
      el.append(row);
    }
  } else {
    el.style.maxHeight = `${maxHeight}px`;
    el.style.setProperty("--row-h", `${rowHeight}px`);
    inner = h("div", { class: "rows-inner" });
    inner.style.height = `${items.length * rowHeight}px`;
    el.append(inner);
    let frame = 0;
    paint = () => {
      frame = 0;
      const top = el.scrollTop;
      const height = el.clientHeight || maxHeight;
      const first = Math.max(0, Math.floor(top / rowHeight) - 10);
      const last = Math.min(items.length - 1, Math.ceil((top + height) / rowHeight) + 10);
      for (const [i, row] of rows) {
        if (i < first || i > last) {
          row.remove();
          rows.delete(i);
        }
      }
      for (let i = first; i <= last; i++) {
        if (rows.has(i)) continue;
        const row = makeRow(i);
        row.style.transform = `translateY(${i * rowHeight}px)`;
        rows.set(i, row);
        inner.append(row);
      }
    };
    el.addEventListener("scroll", () => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    });
    // First paint once the container is in the document and has a height.
    requestAnimationFrame(paint);
    paint();
  }

  function select(i, options = {}) {
    if (items.length === 0) return;
    const next = Math.max(0, Math.min(items.length - 1, i));
    const old = rows.get(current);
    if (old) {
      old.classList.remove("is-selected");
      old.setAttribute("aria-selected", "false");
    }
    current = next;
    if (virtual && options.scroll !== false) {
      const top = next * rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + el.clientHeight)
        el.scrollTop = top + rowHeight - el.clientHeight;
      paint();
    }
    const row = rows.get(current);
    if (row) {
      row.classList.add("is-selected");
      row.setAttribute("aria-selected", "true");
      if (options.scroll !== false && !virtual) row.scrollIntoView({ block: "nearest" });
    }
    if (!options.silent) onSelect?.(items[current], current);
  }

  return list;
}

/** Scroll a section into view; smoothly only when the reader has not asked for less motion. */
export function scrollToSection(id) {
  const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  document
    .getElementById(id)
    ?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
}
