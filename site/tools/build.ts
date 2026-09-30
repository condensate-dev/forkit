/**
 * `bun run site:build`: sync the book into Vocs pages, build the site, and write the static
 * result to site/dist, ready to serve at condensate.dev/forkit/.
 *
 * It installs site/'s own dependencies first (site/ is not a workspace package; see
 * site/README.md), so it works from a clean clone, and runs the vocs binary from
 * site/node_modules, never a globally cached one.
 *
 * Vocs (full-static) writes pre-rendered HTML plus a server bundle to site/.vocs/build; only its
 * public/ tree is the site. Two fix-ups on the HTML:
 * - Vocs renders the "skip to content" link as `/<route>#vocs-content`, without the base path,
 *   which under /forkit/ would leave the page; it becomes the in-page `#vocs-content`.
 * - Inline scripts (the theme bootstrap, Waku's bootstrap, each page's RSC payload) move into
 *   files under assets/inline/, named by content hash. condensate.dev serves
 *   `Content-Security-Policy: script-src 'self'`, which blocks inline scripts: the pages would
 *   never hydrate (no theme, no search, no hero shader). A synchronous `<script src>` in the same
 *   place runs in the same order. JSON-LD (`type="application/ld+json"`) is data and stays inline.
 * And one on every text file: Vocs puts the build directory's absolute path into the config it
 * ships to the browser and into search-index ids; it is stripped, so the site carries no
 * build-machine paths (site:check fails if one remains).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { BASE } from "../src/base.ts";
import { ROOT } from "./book.ts";

const SITE = join(ROOT, "site");
const BUILT = join(SITE, ".vocs/build/public");
const DIST = join(SITE, "dist");

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: SITE, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

run("bun", ["install", "--frozen-lockfile"]);
run("bun", ["tools/sync-docs.ts"]);
rmSync(join(SITE, ".vocs/build"), { recursive: true, force: true });
run(join(SITE, "node_modules/.bin/vocs"), ["build"]);
rmSync(DIST, { recursive: true, force: true });
cpSync(BUILT, DIST, { recursive: true });

const INLINE_DIR = join(DIST, "assets/inline");
mkdirSync(INLINE_DIR, { recursive: true });
const written = new Set<string>();

/** Move one inline script into assets/inline/<hash>.js; return the tag that loads it. */
function externalize(attrs: string, body: string): string {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const file = `${hash}.js`;
  if (!written.has(file)) {
    writeFileSync(join(INLINE_DIR, file), body);
    written.add(file);
  }
  return `<script${attrs} src="${BASE}/assets/inline/${file}"></script>`;
}

let skipLinks = 0;
let scripts = 0;
for (const file of htmlFiles(DIST)) {
  const html = readFileSync(file, "utf8");
  let next = html.replace(/href="\/[^"#]*#vocs-content"/g, () => {
    skipLinks++;
    return 'href="#vocs-content"';
  });
  next = next.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/g,
    (tag, attrs: string, body: string) => {
      const data = /\stype="(?!module"|text\/javascript")[^"]*"/.test(attrs);
      if (data || /\ssrc="/.test(attrs) || body.trim() === "") return tag;
      scripts++;
      return externalize(attrs, body);
    },
  );
  if (next !== html) writeFileSync(file, next);
}
// Strip the build machine's path from everything text (config, search index, pages).
let stripped = 0;
function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return textFiles(path);
    return /\.(js|json|html|txt|xml)$/.test(name) ? [path] : [];
  });
}
for (const file of textFiles(DIST)) {
  const text = readFileSync(file, "utf8");
  if (!text.includes(SITE)) continue;
  writeFileSync(file, text.replaceAll(`${SITE}/`, "").replaceAll(SITE, "."));
  stripped++;
}

console.log(
  `site:build: wrote site/dist (${skipLinks} skip links fixed, ${scripts} inline scripts moved into ${written.size} files, build path stripped from ${stripped} files)`,
);
