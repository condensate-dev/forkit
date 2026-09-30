/**
 * Screenshot test for the forkit site (site/, Vocs): serve the built site/dist under /forkit/,
 * as condensate.dev will, and render the home page and a docs page in headless Chromium at 390
 * and 1440 px, light and dark. PNGs go to FORKIT_SCREENS_DIR; never commit them. CI uploads them
 * as an artifact, which is how they reach the PR.
 *
 * Run `bun run site:build` first. The server sends condensate.dev's Content-Security-Policy
 * (`script-src 'self'`, no inline scripts), so a page that only works with inline scripts fails
 * here as it would in production. For each page it checks that nothing 404s, that the page loads
 * nothing from outside the site (no network), that it logs no errors (a CSP violation is one),
 * that it hydrated (Vocs set the theme), that Vocs' third-party "Ask AI" widgets are gone, that
 * every image loads, that the home page's hero shader mounted and drew, and that the page never
 * scrolls sideways.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const OUT = process.env.FORKIT_SCREENS_DIR ?? "/tmp/forkit-site-screens";
const DIST = resolve(import.meta.dirname, "../../../../site/dist");
const BASE = "/forkit";
const PAGES = [
  { name: "home", path: "/" },
  { name: "docs", path: "/docs/getting-started/vitest" },
] as const;
const WIDTHS = [390, 1440] as const;
/** condensate.dev's policy, as served by its Cloudflare Pages project. */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const SCHEMES = ["light", "dark"] as const;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

let server: Server;
let origin: string;
let browser: Browser;

/** A static file server over site/dist mounted at /forkit/, like a Pages deployment. */
function serveSite(): Promise<Server> {
  const s = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) {
      res.writeHead(404).end();
      return;
    }
    const target = normalize(join(DIST, pathname.slice(BASE.length)));
    if (!target.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    for (const file of [target, join(target, "index.html"), `${target}.html`]) {
      try {
        const body = await readFile(file);
        res.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "content-security-policy": CSP,
        });
        res.end(body);
        return;
      } catch {
        // Try the next candidate.
      }
    }
    res.writeHead(404).end();
  });
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(s)));
}

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("site/dist is missing: run `bun run site:build` before the site screenshots");
  }
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

describe.each(PAGES)("site: $name", ({ name, path }) => {
  describe.each(SCHEMES)("%s", (scheme) => {
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

      await page.goto(`${origin}${BASE}${path}`, { waitUntil: "networkidle" });
      await page.locator("h1").first().waitFor();
      // Vocs picks the theme from prefers-color-scheme before first paint (its bootstrap script
      // must survive the CSP).
      expect(await page.getAttribute("html", "data-vocs-theme")).toBe(scheme);
      // No third-party AI: Vocs' "Ask AI" box and "Copy page for AI" menu are switched off.
      expect(await page.getByText(/Ask AI|Copy page for AI/).count()).toBe(0);
      expect(await page.locator('a[href*="chatgpt.com"], a[href*="claude.ai"]').count()).toBe(0);
      if (name === "home") {
        // The hero shader mounted: the component sized the canvas to its box (an unmounted canvas
        // stays at the default 300x150) and drew, or fell back to the static gradient.
        const hero = (await page.evaluate(`(() => {
          const host = document.querySelector(".fk-vapor");
          const canvas = host && host.querySelector("canvas");
          return { fallback: !!host && host.classList.contains("is-static"),
                   width: canvas ? canvas.width : 0, clientWidth: canvas ? canvas.clientWidth : 0 };
        })()`)) as { fallback: boolean; width: number; clientWidth: number };
        expect(hero.fallback, "the shader fell back to the static gradient").toBe(false);
        expect(hero.width, "the hero canvas was never sized by the component").not.toBe(300);
        expect(hero.width).toBeGreaterThan(hero.clientWidth * 0.4);
      }
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
      await page.screenshot({
        path: join(OUT, `site-${name}-${width}-${scheme}.png`),
        fullPage: true,
      });
      await context.close();

      expect(offsite, "the site must not touch the network").toEqual([]);
      expect(failed).toEqual([]);
      expect(broken, "images that did not load").toEqual([]);
      expect(errors).toEqual([]);
      expect(overflow, `scrolls sideways at ${width}px`).toBeLessThanOrEqual(0);
    });
  });
});
