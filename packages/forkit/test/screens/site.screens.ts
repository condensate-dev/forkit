/**
 * Screenshot test for the condensate.dev/forkit page (site/forkit): serve site/ so the page
 * loads under the /forkit/ subpath, as it will on Cloudflare Pages, and render it in headless
 * Chromium at 390 and 1440 px, light and dark. PNGs go to FORKIT_SCREENS_DIR; never commit them.
 *
 * It checks that every asset resolves under the subpath (no 404s, no root-absolute URLs), that
 * the page loads nothing from the network and logs no errors, and that it never scrolls sideways.
 */

import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const OUT = process.env.FORKIT_SCREENS_DIR ?? "/tmp/forkit-m9-screens";
const SITE = resolve(import.meta.dirname, "../../../../site");
const WIDTHS = [390, 1440] as const;
const SCHEMES = ["light", "dark"] as const;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

let server: Server;
let origin: string;
let browser: Browser;

/** A static file server over site/, like a Pages deployment: `/forkit/` serves its index.html. */
function serveSite(): Promise<Server> {
  const s = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(SITE, path));
    if (!file.startsWith(SITE)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(s)));
}

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  server = await serveSite();
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((ok) => server?.close(ok));
});

test("every local URL in index.html is relative, so the page works under /forkit/", async () => {
  const html = await readFile(join(SITE, "forkit/index.html"), "utf8");
  const css = await readFile(join(SITE, "forkit/assets/site.css"), "utf8");
  const urls = [
    ...[...html.matchAll(/\s(?:src|href|srcset)="([^"]+)"/g)].map((m) => m[1] ?? ""),
    ...[...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1] ?? ""),
  ];
  const rootAbsolute = urls.filter((u) => u.startsWith("/") && !u.startsWith("//"));
  expect(rootAbsolute).toEqual([]);
  expect(html).not.toContain("(run site/tools/build-assets.ts)");
});

describe.each(SCHEMES)("site/forkit, %s", (scheme) => {
  test.each(WIDTHS)("at %i px", async (width) => {
    const context = await browser.newContext({
      viewport: { width, height: width < 600 ? 844 : 900 },
      deviceScaleFactor: width < 600 ? 2 : 1,
      colorScheme: scheme,
    });
    const page = await context.newPage();
    const offsite: string[] = [];
    const failed: string[] = [];
    const errors: string[] = [];
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      offsite.push(url.href);
      return route.abort();
    });
    page.on("response", (response) => {
      if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${origin}/forkit/`);
    await page.locator("h1").waitFor();
    // Load the lazy screenshots before measuring and capturing.
    await page.evaluate(
      "Promise.all([...document.images].map((i) => { i.loading = 'eager'; return i.decode().catch(() => {}); }))",
    );
    const broken = (await page.evaluate(
      "[...document.images].filter((i) => i.naturalWidth === 0).map((i) => i.currentSrc || i.src)",
    )) as string[];
    const overflow = (await page.evaluate(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    )) as number;
    await page.screenshot({ path: join(OUT, `site-${scheme}-${width}.png`), fullPage: true });
    await context.close();

    expect(offsite, "the page must not touch the network").toEqual([]);
    expect(failed).toEqual([]);
    expect(broken, "images that did not load").toEqual([]);
    expect(errors).toEqual([]);
    expect(overflow, `scrolls sideways at ${width}px`).toBeLessThanOrEqual(0);
  });
});
