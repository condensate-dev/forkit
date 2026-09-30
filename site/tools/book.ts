/**
 * The forkit book (docs/) as the site's docs: routes and sidebar from docs/SUMMARY.md, and the
 * link rewriting that turns the book's relative `.md` links into site routes.
 *
 * docs/ stays the single source (it also reads well on GitHub); site/tools/sync-docs.ts copies it
 * into site/src/pages/docs at build time, and vocs.config.ts builds the sidebar from the same
 * table of contents, so the two can never disagree.
 */
import { readFileSync } from "node:fs";
import { dirname, join, normalize, posix, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
export const DOCS = join(ROOT, "docs");

/** Book pages the site leaves out: the internal design spec (milestones, clean-room notes). */
export const EXCLUDED = new Set(["spec.md"]);

/** The root CHANGELOG.md joins the book as /docs/changelog. */
export const CHANGELOG = {
  source: "../CHANGELOG.md",
  route: "/docs/changelog",
  title: "Changelog",
};

export interface SidebarItem {
  text: string;
  link?: string;
  items?: SidebarItem[];
  collapsed?: boolean;
}

/** `getting-started/README.md` → `/docs/getting-started`, `faq.md` → `/docs/faq`. */
export function routeOf(source: string): string {
  const path = source.replace(/\.md$/, "").replace(/(^|\/)README$/, "");
  return path === "" ? "/docs" : `/docs/${path.replace(/\/$/, "")}`;
}

/** Every book page in SUMMARY order, as `{ title, source }` (source relative to docs/). */
export function bookPages(): { title: string; source: string }[] {
  const summary = readFileSync(join(DOCS, "SUMMARY.md"), "utf8");
  return [...summary.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g)]
    .map((m) => ({ title: m[1] ?? "", source: m[2] ?? "" }))
    .filter((p) => !EXCLUDED.has(p.source));
}

/**
 * The sidebar, from SUMMARY.md: `## Section` headings become groups, `- [x](y)` items links, and
 * indented items children. The Changelog joins the last group.
 */
export function sidebar(): SidebarItem[] {
  const lines = readFileSync(join(DOCS, "SUMMARY.md"), "utf8").split("\n");
  const groups: SidebarItem[] = [];
  let current: SidebarItem | undefined;
  let parent: SidebarItem | undefined;
  for (const line of lines) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      current = { text: heading[1] ?? "", items: [] };
      groups.push(current);
      continue;
    }
    const intro = /^\[([^\]]+)\]\(([^)]+\.md)\)/.exec(line);
    if (intro) {
      groups.push({ text: intro[1] ?? "", link: routeOf(intro[2] ?? "") });
      continue;
    }
    const item = /^(\s*)- \[([^\]]+)\]\(([^)]+\.md)\)/.exec(line);
    if (!item || current === undefined || EXCLUDED.has(item[3] ?? "")) continue;
    const entry: SidebarItem = { text: item[2] ?? "", link: routeOf(item[3] ?? "") };
    if ((item[1] ?? "").length > 0 && parent !== undefined) {
      parent.items ??= [];
      parent.items.push(entry);
    } else {
      current.items?.push(entry);
      parent = entry;
    }
  }
  groups.at(-1)?.items?.push({ text: CHANGELOG.title, link: CHANGELOG.route });
  return groups;
}

/** The GitHub URL of a repository file, for links that leave the book. */
export const githubUrl = (path: string) =>
  `https://github.com/condensate-dev/forkit/blob/main/${path}`;

/**
 * Rewrite one Markdown link target found in `source` (a path relative to docs/):
 * - a book page → its route (anchors kept);
 * - SUMMARY.md (the book's table of contents) → the docs home;
 * - an excluded page, or any other repository file → its GitHub URL;
 * - URLs and in-page anchors unchanged.
 */
export function rewriteLink(target: string, source: string): string {
  if (/^[a-z]+:/i.test(target) || target.startsWith("#")) return target;
  const [path = "", hash] = target.split("#");
  // A repository-root file (the CHANGELOG) links into the book as `docs/...`.
  const resolved = normalize(posix.join(dirname(source), path))
    .replaceAll("\\", "/")
    .replace(/^\.\.\/docs\//, "");
  const anchor = hash === undefined ? "" : `#${hash}`;
  if (resolved === "SUMMARY.md") return `/docs${anchor}`;
  if (resolved.endsWith(".md") && !resolved.startsWith("..") && !EXCLUDED.has(resolved)) {
    return `${routeOf(resolved)}${anchor}`;
  }
  const fromRoot = resolved.startsWith("../") ? resolved.slice(3) : `docs/${resolved}`;
  return `${githubUrl(fromRoot)}${anchor}`;
}

/** The book page a link target points at (a path relative to docs/), if any. */
export function bookPageOf(target: string, source: string): string | undefined {
  if (/^[a-z]+:/i.test(target) || target.startsWith("#")) return undefined;
  const resolved = normalize(posix.join(dirname(source), target.split("#")[0] ?? ""))
    .replaceAll("\\", "/")
    .replace(/^\.\.\/docs\//, "");
  if (!resolved.endsWith(".md") || resolved.startsWith("..") || EXCLUDED.has(resolved)) {
    return undefined;
  }
  return resolved === "SUMMARY.md" ? undefined : resolved;
}

/** A book page's title: its first `# ` heading, without Markdown code ticks. */
export function pageTitle(page: string): string {
  const heading = /^# (.+)$/m.exec(readFileSync(join(DOCS, page), "utf8"));
  if (!heading) throw new Error(`book: ${page} has no # heading to title a link with`);
  return (heading[1] ?? "").replaceAll("`", "").trim();
}

/**
 * Rewrite every inline Markdown link `[text](target)` in `markdown` (outside code): the target
 * through {@link rewriteLink}, and a link whose text is just a file name (`[vitest.md](vitest.md)`,
 * natural in the book on GitHub) gets the target page's title instead, so the site never shows
 * `.md` names.
 */
export function rewriteLinks(markdown: string, source: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) return line;
      // Leave inline code spans alone: split on backtick runs and rewrite outside them only.
      return line
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith("`")
            ? part
            : part.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, text: string, target: string) => {
                const page = bookPageOf(target, source);
                const label =
                  page !== undefined && /^[\w./-]+\.md$/.test(text.trim()) ? pageTitle(page) : text;
                return `[${label}](${rewriteLink(target, source)})`;
              }),
        )
        .join("");
    })
    .join("\n");
}
