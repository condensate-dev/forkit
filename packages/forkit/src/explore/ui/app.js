// forkit explore: a read-only explorer over forkit run records. Plain DOM, no framework, no
// network beyond this server's /api. Every string from a run record goes in as text, never HTML.

import { activeNav, announce, cx, h, hideTip, icon, setActiveNav } from "./lib/dom.js";
import { formatTime } from "./lib/format.js";
import { indexRun, parseHash, route, search } from "./lib/model.js";
import { viewAddress } from "./views/address.js";
import { viewRun, viewRuns } from "./views/run.js";
import { viewTest } from "./views/test.js";
import { viewTx } from "./views/tx.js";

const app = document.getElementById("app");
const crumbs = document.getElementById("crumbs");
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
const help = document.getElementById("help");

const runCache = new Map();
let runList;
let current;
let crumbTrail = [];

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
// Router

const go = (hash) => {
  location.hash = hash;
};

/** Update the URL's params (a selection) without re-rendering: every selection is a deep link. */
function setParams(update) {
  const { parts, params } = parseHash(location.hash);
  for (const [k, v] of Object.entries(update)) {
    if (v === undefined || v === null || v === "") params.delete(k);
    else params.set(k, String(v));
  }
  history.replaceState(null, "", route(parts, Object.fromEntries(params)));
}

function setCrumbs(items) {
  // On a phone the trail scrolls sideways: show its end, the page you are on.
  requestAnimationFrame(() => {
    crumbs.scrollLeft = crumbs.scrollWidth;
  });
  crumbTrail = items;
  crumbs.replaceChildren();
  items.forEach((item, i) => {
    if (i > 0) crumbs.append(h("span", { class: "sep", "aria-hidden": "true" }, "/"));
    crumbs.append(
      item.href
        ? h("a", { href: item.href }, item.text)
        : h("span", { "aria-current": "page", title: item.text }, item.text),
    );
  });
}

function notFound(message) {
  return {
    title: "Not found",
    crumbs: [{ text: "Runs", href: "#/" }, { text: "Not found" }],
    body: [
      h(
        "div",
        { class: "callout is-bad" },
        h("h2", null, "Not found"),
        h("p", null, message),
        h("a", { href: "#/" }, "All runs"),
      ),
    ],
  };
}

let lastPath;
async function render() {
  const { parts, params } = parseHash(location.hash);
  const path = parts.join("/");
  const ctx = { params, go, setParams };
  let view;
  setActiveNav(undefined);
  hideTip();
  // A search the reader is already typing (a fast "/" after the last jump) stays open.
  if (document.activeElement !== searchInput) closeSearch();
  try {
    if (parts.length === 0) {
      runList = await getJson("/api/runs");
      current = undefined;
      view = viewRuns(runList, go);
    } else if (parts[0] === "run" && parts[1] !== undefined) {
      const idx = await loadRun(parts[1]);
      current = idx;
      const [, , kind, arg] = parts;
      if (kind === undefined) view = viewRun(idx, go);
      else if (kind === "test")
        view = viewTest(idx, arg, ctx) ?? notFound(`No test ${arg} in this run.`);
      else if (kind === "tx")
        view = viewTx(idx, arg, ctx) ?? notFound(`No transaction ${arg} in this run.`);
      else if (kind === "address" && /^0x[0-9a-fA-F]{40}$/.test(arg ?? ""))
        view = viewAddress(idx, arg, ctx);
      else view = notFound(`Unknown view ${kind}.`);
    } else {
      view = notFound("Unknown page.");
    }
  } catch (error) {
    view = {
      title: "Could not load",
      crumbs: [{ text: "Runs", href: "#/" }],
      body: [
        h(
          "div",
          { class: "callout is-bad" },
          h("h2", null, "Could not load"),
          h("p", null, error.message),
          h("a", { href: "#/" }, "All runs"),
        ),
      ],
    };
  }
  app.replaceChildren(...[view.body].flat(Infinity).filter(Boolean));
  if (view.nav) setActiveNav(view.nav);
  setCrumbs(view.crumbs);
  document.title = `${view.title} · forkit explore`;
  searchInput.placeholder = current
    ? `Search ${current.run.id}: tx, address, label, test`
    : "Search runs";
  if (path !== lastPath && !params.has("section") && !params.has("step")) window.scrollTo(0, 0);
  lastPath = path;
}

window.addEventListener("hashchange", render);

// ---------------------------------------------------------------------------------------------
// Search: a combobox over the open run (or the run list).

let results = [];
let highlighted = -1;

function resultHref(result) {
  if (result.kind === "run") return route(["run", result.id]);
  const id = current.run.id;
  if (result.kind === "test") return route(["run", id, "test", result.key]);
  if (result.kind === "tx") return route(["run", id, "tx", result.id]);
  return route(["run", id, "address", result.address]);
}

function closeSearch() {
  results = [];
  highlighted = -1;
  searchResults.hidden = true;
  searchResults.replaceChildren();
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
}

function paintResults() {
  searchResults.replaceChildren(
    ...(results.length === 0
      ? [h("div", { class: "sr-empty", role: "presentation" }, "No match in this run.")]
      : results.map((r, i) =>
          h(
            "div",
            {
              id: `sr-${i}`,
              role: "option",
              class: cx("sr-item", i === highlighted && "is-active"),
              "aria-selected": String(i === highlighted),
              onmousedown: (event) => {
                event.preventDefault();
                choose(i);
              },
            },
            h(
              "span",
              { class: `tag tag-${r.kind === "tx" ? "tx" : r.kind === "test" ? "fill" : "kind"}` },
              r.kind,
            ),
            h("span", { class: "sr-text" }, r.text),
            r.sub ? h("span", { class: "sr-sub mono" }, r.sub) : null,
          ),
        )),
  );
  searchResults.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
  if (highlighted >= 0) searchInput.setAttribute("aria-activedescendant", `sr-${highlighted}`);
  else searchInput.removeAttribute("aria-activedescendant");
}

function choose(i) {
  const result = results[i];
  if (!result) return;
  closeSearch();
  searchInput.value = "";
  searchInput.blur();
  go(resultHref(result));
}

function runSearch() {
  const q = searchInput.value.trim();
  if (q === "") return closeSearch();
  if (current) results = search(current, q);
  else
    results = (runList ?? [])
      .filter((r) => r.id.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 12)
      .map((r) => ({ kind: "run", text: r.id, sub: formatTime(r.startedAt), id: r.id }));
  highlighted = results.length > 0 ? 0 : -1;
  paintResults();
  announce(`${results.length} result${results.length === 1 ? "" : "s"}`);
}

searchInput.addEventListener("input", runSearch);

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (results.length === 0) return;
    event.preventDefault();
    highlighted =
      (highlighted + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
    paintResults();
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (results.length === 0) runSearch();
    choose(highlighted >= 0 ? highlighted : 0);
  } else if (event.key === "Escape") {
    closeSearch();
    searchInput.blur();
  }
});

searchInput.addEventListener("blur", () => setTimeout(closeSearch, 100));
document.getElementById("search").addEventListener("submit", (event) => event.preventDefault());

// ---------------------------------------------------------------------------------------------
// Keyboard: j/k move, h/l collapse and expand, Enter opens, / searches, u goes up, ? helps.

function typing(target) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (typing(event.target)) return;
  if (document.querySelector("dialog[open]") && event.key !== "Escape") return;
  const list = activeNav();
  switch (event.key) {
    case "/":
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    case "?":
      event.preventDefault();
      if (help.open) help.close();
      else help.showModal();
      return;
    case "j":
    case "k":
      if (!list) return;
      event.preventDefault();
      list.select(list.selected < 0 ? 0 : list.selected + (event.key === "j" ? 1 : -1));
      return;
    case "h":
    case "l":
      if (!list?.left) return;
      event.preventDefault();
      if (event.key === "h") list.left();
      else list.right();
      return;
    case "Enter":
    case "o":
      if (!list || list.selected < 0) return;
      if (event.target instanceof HTMLElement && event.target.closest("a, button, summary")) return;
      event.preventDefault();
      list.activate();
      return;
    case "u": {
      const up = [...crumbTrail].reverse().find((c) => c.href);
      if (up) {
        event.preventDefault();
        go(up.href);
      }
      return;
    }
  }
});

document.getElementById("help-button").addEventListener("click", () => help.showModal());
help.querySelector("[data-close]").addEventListener("click", () => help.close());
help.addEventListener("click", (event) => {
  if (event.target === help) help.close();
});

// Keep icons in static markup too (the help button).
document.getElementById("help-button").prepend(icon("keyboard"));

render();
