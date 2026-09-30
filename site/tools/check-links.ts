/**
 * Link check for the built site: `bun run site:check` (after site:build). Offline, so it runs in
 * CI without network. Vocs already fails the build on dead page links (checkDeadlinks); this
 * checks what the deployed files actually reference, under the /forkit/ base path:
 *
 * - every local href/src (pages, scripts, styles, images, icons) resolves to a file in site/dist;
 * - every `#fragment` on a local page link exists as an id on that page;
 * - nothing is root-absolute outside /forkit/ (it would leave the subpath on condensate.dev);
 * - no <base> tag (Vocs emits one for `baseUrl`, which sends lazy chunks to production);
 * - no `.md` links: every book link must be a site route, never a local `.md` file or this
 *   repository's `.md` on GitHub, and no link may show a bare `.md` file name as its text
 *   (third-party `.md` documents, such as another project's docs on GitHub, are fine);
 * - no build-machine paths (the checkout's absolute path) anywhere in the output;
 * - no third-party AI: no "Ask AI" box and no links to ChatGPT or Claude (Vocs' AI widgets);
 * - no inline executable <script>: the site must run under `script-src 'self'` (condensate.dev's
 *   Content-Security-Policy), so build.ts moves them into files.
 *
 * External links are listed with a count, not fetched.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BASE } from "../src/base.ts";
import { ROOT } from "./book.ts";

const DIST = join(ROOT, "site/dist");

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return name.endsWith(ext) ? [path] : [];
  });
}

/** The file a URL path under BASE serves, as a static host would. */
function resolveFile(pathname: string): string | undefined {
  const rel = decodeURIComponent(pathname.slice(BASE.length)).replace(/^\//, "");
  const target = join(DIST, rel);
  for (const candidate of [target, join(target, "index.html"), `${target}.html`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

const idCache = new Map<string, Set<string>>();
function idsOf(file: string): Set<string> {
  let ids = idCache.get(file);
  if (ids === undefined) {
    const html = readFileSync(file, "utf8");
    ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ""));
    idCache.set(file, ids);
  }
  return ids;
}

if (!existsSync(DIST)) throw new Error("site/dist does not exist: run `bun run site:build` first");

const problems: string[] = [];
const external = new Set<string>();
let checked = 0;
const pages = files(DIST, ".html");
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const where = relative(DIST, page);
  if (/<base\s/i.test(html)) problems.push(`${where}: has a <base> tag`);
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1] ?? "";
    const executable = !/\stype="(?!module"|text\/javascript")[^"]*"/.test(attrs);
    if (executable && !/\ssrc="/.test(attrs) && (m[2] ?? "").trim() !== "") {
      problems.push(`${where}: inline <script${attrs}> (blocked by script-src 'self')`);
    }
  }
  if (/>Ask AI|data-v-ask-ai|chatgpt\.com|claude\.ai/.test(html)) {
    problems.push(`${where}: renders Vocs' Ask AI or links a third-party AI`);
  }
  for (const m of html.matchAll(/<a\b[^>]*>([^<]+)<\/a>/g)) {
    if (/^\s*[\w./-]+\.md\s*$/.test(m[1] ?? "")) {
      problems.push(`${where}: a link shows the file name "${(m[1] ?? "").trim()}" as its text`);
    }
  }
  // Drop script bodies and styles; tag attributes (including <script src>) are checked.
  const markup = html
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/g, "$1$2")
    .replace(/<style[\s\S]*?<\/style>/g, "");
  for (const m of markup.matchAll(/\s(href|src)="([^"]*)"/g)) {
    const url = m[2] ?? "";
    if (url === "" || url.startsWith("data:") || url.startsWith("mailto:")) continue;
    if (/^https?:\/\//.test(url)) {
      if (/^https:\/\/github\.com\/condensate-dev\/forkit\/[^#?]*\.md(?:[#?]|$)/.test(url)) {
        problems.push(`${where}: ${url} links a .md file of this repository; link its site route`);
      }
      external.add(url);
      continue;
    }
    if (/\.md(?:[#?]|$)/.test(url)) {
      problems.push(`${where}: ${url} links a .md file; book links must be site routes`);
      continue;
    }
    checked++;
    if (url.startsWith("#")) {
      if (url !== "#" && !idsOf(page).has(decodeURIComponent(url.slice(1)))) {
        problems.push(`${where}: anchor ${url} has no matching id on the page`);
      }
      continue;
    }
    if (!url.startsWith("/")) {
      problems.push(`${where}: relative URL ${url} (Vocs links are absolute under ${BASE}/)`);
      continue;
    }
    const [pathname = "", hash] = url.split("#");
    if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) {
      problems.push(`${where}: ${url} is outside ${BASE}/, so it would leave the subpath`);
      continue;
    }
    const file = resolveFile(pathname);
    if (file === undefined) {
      problems.push(`${where}: ${url} does not resolve to a file in site/dist`);
      continue;
    }
    if (hash !== undefined && hash !== "" && file.endsWith(".html")) {
      if (!idsOf(file).has(decodeURIComponent(hash))) {
        problems.push(`${where}: ${url}: no id "${hash}" on ${relative(DIST, file)}`);
      }
    }
  }
}

for (const file of files(DIST, "")) {
  if (!/\.(js|json|html|txt|xml)$/.test(file)) continue;
  if (readFileSync(file, "utf8").includes(ROOT)) {
    problems.push(`${relative(DIST, file)}: contains the build machine's path ${ROOT}`);
  }
}

console.log(
  `site:check: ${pages.length} pages, ${checked} local links and assets, ${external.size} external links (not fetched)`,
);
if (problems.length > 0) {
  console.error([...new Set(problems)].map((p) => `  ✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log("site:check: every local link and asset resolves under the base path");
