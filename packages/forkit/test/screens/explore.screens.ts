/**
 * Screenshot test for `forkit explore`: serve the showcase run record, render every view in
 * headless Chromium at 390 px (mobile) and 1440 px, and write PNGs to FORKIT_SCREENS_DIR
 * (default /tmp/forkit-m9-screens). Never commit them. It also checks that the UI loads nothing
 * from the network, logs no errors, and never scrolls sideways at 390 px.
 *
 * Needs Playwright's Chromium: `npx playwright install chromium`.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { RunRecord } from "../../src/explore/schema.ts";
import { type ExploreServer, startExploreServer } from "../../src/explore/server.ts";

const OUT = process.env.FORKIT_SCREENS_DIR ?? "/tmp/forkit-m9-screens";
const FIXTURE = resolve(import.meta.dirname, "../fixtures/explore/showcase.json");
const WIDTHS = [390, 1440] as const;

let server: ExploreServer;
let browser: Browser;
let run: RunRecord;

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  server = await startExploreServer({ files: [FIXTURE] });
  run = (await (await fetch(`${server.url}api/runs/showcase`)).json()) as RunRecord;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Open a view at a width, check it, and save a full-page screenshot. */
async function capture(hash: string, width: number, name: string, expectText: string) {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    deviceScaleFactor: width < 600 ? 2 : 1,
    colorScheme: "light",
  });
  const page: Page = await context.newPage();
  const offsite: string[] = [];
  const errors: string[] = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    offsite.push(url.href);
    return route.abort();
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.url}${hash}`);
  await page.locator(".page-head h1").first().waitFor();
  await expect.poll(() => page.locator("#app").innerText()).toContain(expectText);
  // A string, evaluated in the page: this file is typed without the DOM library.
  const overflow = (await page.evaluate(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  )) as number;
  await page.screenshot({ path: join(OUT, `${name}-${width}.png`), fullPage: true });
  await context.close();
  expect(offsite, "the explorer must not touch the network").toEqual([]);
  expect(errors).toEqual([]);
  expect(overflow, `${name} at ${width}px scrolls sideways`).toBeLessThanOrEqual(0);
}

describe.each(WIDTHS)("forkit explore at %i px", (width) => {
  test("run list", async () => {
    await capture("#/", width, "explore-runs", "showcase");
  });

  test("run overview (tests, forks, fills)", async () => {
    await capture("#/run/showcase", width, "explore", "Cross-chain fills");
  });

  test("test timeline", async () => {
    const test = run.tests.find((t) => t.name.startsWith("bridges"));
    expect(test).toBeDefined();
    await capture(`#/run/showcase/test/${test?.key}`, width, "explore-test", "Timeline");
  });

  test("tx view: decoded call, trace, events, cross-chain link", async () => {
    const deposit = run.txs.find((t) => t.call?.name === "deposit" && t.status === "success");
    expect(deposit).toBeDefined();
    await capture(`#/run/showcase/tx/${deposit?.id}`, width, "explore-tx", "Call trace");
  });

  test("tx view: a revert", async () => {
    const reverted = run.txs.find((t) => t.status === "reverted");
    expect(reverted).toBeDefined();
    await capture(`#/run/showcase/tx/${reverted?.id}`, width, "explore-revert", "Reverted");
  });

  test("address view: labels and balance history", async () => {
    const alice = Object.entries(run.labels).find(([, name]) => name === "alice")?.[0];
    expect(alice).toBeDefined();
    await capture(`#/run/showcase/address/${alice}`, width, "explore-address", "balance");
  });
});
