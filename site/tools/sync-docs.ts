/**
 * Copy the forkit book (docs/) and the CHANGELOG into site/src/pages/docs, as Vocs pages:
 * `bun site/tools/sync-docs.ts` (site:build runs it first). The output is generated and
 * gitignored; edit docs/, never site/src/pages/docs.
 *
 * Besides rewriting links (see book.ts), it makes three site-only edits, each asserted so a
 * change in the book fails loudly instead of leaving a stale page:
 * - the book's front page loses its centred logo (the site header has one) and its pointer to
 *   SUMMARY.md (the site has a sidebar);
 * - the landscape page's link to the internal design spec becomes plain text.
 *
 * Every page also gets `showAskAi: false` frontmatter: Vocs' "Ask AI" box and "Copy page for AI"
 * menu send readers to third-party AI sites, which the site must not do. Vocs has no site-wide
 * switch for them.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bookPages, CHANGELOG, DOCS, ROOT, rewriteLinks, routeOf } from "./book.ts";

const PAGES = join(ROOT, "site/src/pages/docs");

function edit(text: string, source: string, from: string | RegExp, to: string): string {
  const next = text.replace(from, to);
  if (next === text) {
    throw new Error(
      `sync-docs: ${source} no longer contains ${String(from)}; update site/tools/sync-docs.ts`,
    );
  }
  return next;
}

const SITE_EDITS: Record<string, (text: string, source: string) => string> = {
  "README.md": (text, source) =>
    edit(
      edit(text, source, /^<p align="center"><img [^>]*><\/p>\n\n/m, ""),
      source,
      / The full table of contents is in \[SUMMARY\.md\]\(SUMMARY\.md\)\./,
      "",
    ),
  "landscape.md": (text, source) =>
    edit(text, source, "(from [spec.md](spec.md))", "(from its design spec)"),
};

function pagePath(route: string): string {
  return join(ROOT, "site/src/pages", route, "index.md");
}

rmSync(PAGES, { recursive: true, force: true });
const pages: { title: string; source: string; route?: string }[] = [...bookPages(), CHANGELOG];
for (const page of pages) {
  const sourcePath = join(DOCS, page.source);
  let text = readFileSync(sourcePath, "utf8");
  text = SITE_EDITS[page.source]?.(text, page.source) ?? text;
  text = rewriteLinks(text, page.source);
  if (text.startsWith("---\n")) {
    throw new Error(`sync-docs: ${page.source} has frontmatter; merge showAskAi into it`);
  }
  text = `---\nshowAskAi: false\n---\n\n${text}`;
  const out = pagePath(page.route ?? routeOf(page.source));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
}
console.log(`sync-docs: ${pages.length} pages → site/src/pages/docs`);
