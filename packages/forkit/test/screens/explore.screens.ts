/**
 * Screenshot and behaviour test for `forkit explore`: serve the showcase run record, render every
 * view in headless Chromium at 390 px (a phone), 1024 px and 1440 px, light and dark, and write
 * PNGs to FORKIT_SCREENS_DIR (default /tmp/forkit-explore-screens). Never commit them. Each view
 * must load nothing from the network, log no errors (a CSP violation is one), and never scroll
 * sideways. Then the things a reader does: keyboard navigation, search, deep links, copy as
 * code, and a run too large to render row by row.
 *
 * Needs Playwright's Chromium: `npx playwright install chromium`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { RunRecord } from "../../src/explore/schema.ts";
import { type ExploreServer, startExploreServer } from "../../src/explore/server.ts";

const OUT = process.env.FORKIT_SCREENS_DIR ?? "/tmp/forkit-explore-screens";
const FIXTURE = resolve(import.meta.dirname, "../fixtures/explore/showcase.json");
const WIDTHS = [390, 1024, 1440] as const;
const SCHEMES = ["light", "dark"] as const;
type Scheme = (typeof SCHEMES)[number];
const CASES = WIDTHS.flatMap((width) => SCHEMES.map((scheme) => [width, scheme] as const));

/** Transactions in the synthetic large run. */
const LARGE_TXS = 5_000;

let server: ExploreServer;
let browser: Browser;
let run: RunRecord;
let scratch: string;

/** The showcase run, with its transactions copied until there are `LARGE_TXS`, in one test. */
function largeRun(base: RunRecord): RunRecord {
  const test = base.tests.find((t) => t.name.startsWith("bridges"));
  const txs = Array.from({ length: LARGE_TXS }, (_, i) => {
    const tx = base.txs[i % base.txs.length] as RunRecord["txs"][number];
    return { ...tx, id: `large:${i}`, ts: tx.ts + i, ...(test ? { test: test.key } : {}) };
  });
  return { ...base, id: "large", txs, fills: [] };
}

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  scratch = mkdtempSync(join(tmpdir(), "forkit-explore-screens-"));
  const large = join(scratch, "large.json");
  const base = JSON.parse(readFileSync(FIXTURE, "utf8")) as RunRecord;
  writeFileSync(large, JSON.stringify(largeRun(base)));
  server = await startExploreServer({ files: [FIXTURE, large] });
  run = (await (await fetch(`${server.url}api/runs/showcase`)).json()) as RunRecord;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(scratch, { recursive: true, force: true });
});

interface Opened {
  context: BrowserContext;
  page: Page;
  offsite: string[];
  errors: string[];
}

async function open(hash: string, width: number, scheme: Scheme = "light"): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    deviceScaleFactor: width < 600 ? 2 : 1,
    colorScheme: scheme,
  });
  const page = await context.newPage();
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
  return { context, page, offsite, errors };
}

/** Evaluated in the page, as a string: this file is typed without the DOM library. */
const evaluate = <T>(page: Page, script: string) => page.evaluate(script) as Promise<T>;

async function closeClean({ context, offsite, errors }: Opened) {
  await context.close();
  expect(offsite, "the explorer must not touch the network").toEqual([]);
  expect(errors).toEqual([]);
}

/** Open a view at a width and scheme, check it, and save a full-page screenshot. */
async function capture(hash: string, width: number, scheme: Scheme, name: string, text: string) {
  const opened = await open(hash, width, scheme);
  const { page } = opened;
  await expect.poll(() => page.locator("#app").innerText()).toContain(text);
  const overflow = await evaluate<number>(
    page,
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
  await page.screenshot({ path: join(OUT, `${name}-${width}-${scheme}.png`), fullPage: true });
  await closeClean(opened);
  expect(overflow, `${name} at ${width}px scrolls sideways`).toBeLessThanOrEqual(0);
}

const depositTx = () => run.txs.find((t) => t.call?.name === "deposit" && t.status === "success");
const revertedTx = () => run.txs.find((t) => t.status === "reverted");

describe.each(CASES)("forkit explore at %i px, %s", (width, scheme) => {
  test("run list", async () => {
    await capture("#/", width, scheme, "explore-runs", "showcase");
  });

  test("run overview: failures first, tests, transactions, forks, fills", async () => {
    await capture("#/run/showcase", width, scheme, "explore", "Failures");
  });

  test("test timeline: every transaction and cheat, in order", async () => {
    const test = run.tests.find((t) => t.name.startsWith("bridges"));
    expect(test).toBeDefined();
    await capture(`#/run/showcase/test/${test?.key}`, width, scheme, "explore-test", "PRANK");
  });

  test("a failed test: expected vs actual", async () => {
    const test = run.tests.find((t) => t.status === "fail");
    expect(test).toBeDefined();
    await capture(`#/run/showcase/test/${test?.key}`, width, scheme, "explore-fail", "Expected");
  });

  test("tx view: call tree, gas, transfers, balances, state, events", async () => {
    await capture(
      `#/run/showcase/tx/${depositTx()?.id}`,
      width,
      scheme,
      "explore-tx",
      "State changes",
    );
  });

  test("tx view: a revert, and where it started", async () => {
    await capture(
      `#/run/showcase/tx/${revertedTx()?.id}`,
      width,
      scheme,
      "explore-revert",
      "It started in",
    );
  });

  test("address view: balance over the run and every transaction", async () => {
    const alice = Object.entries(run.labels).find(([, name]) => name === "alice")?.[0];
    expect(alice).toBeDefined();
    await capture(
      `#/run/showcase/address/${alice}`,
      width,
      scheme,
      "explore-address",
      "USDC balance",
    );
  });
});

describe("reading a run", () => {
  test("j/k select tests and Enter opens one; u goes back up", async () => {
    const opened = await open("#/run/showcase", 1440);
    const { page } = opened;
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("k");
    await expect.poll(() => page.locator(".test-list .row.is-selected").count()).toBe(1);
    await page.keyboard.press("Enter");
    // Failures first: the first row is the failed test.
    const failed = run.tests.find((t) => t.status === "fail");
    await expect.poll(() => page.url()).toContain(`/test/${encodeURIComponent(failed?.key ?? "")}`);
    await expect.poll(() => page.locator("#app").innerText()).toContain("Assertion failed");
    await page.keyboard.press("u");
    await expect.poll(() => page.url()).toMatch(/#\/run\/showcase$/);
    await closeClean(opened);
  });

  test("/ searches: a label, a test name and a transaction hash, each to its view", async () => {
    const opened = await open("#/run/showcase", 1440);
    const { page } = opened;
    await page.keyboard.press("/");
    await page.keyboard.type("alice");
    await expect.poll(() => page.locator("#search-results .sr-item").count()).toBeGreaterThan(0);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.url()).toContain("/address/");
    await expect.poll(() => page.locator(".page-head h1").innerText()).toBe("alice");

    await page.keyboard.press("/");
    await page.keyboard.type(depositTx()?.hash?.slice(0, 12) ?? "");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.url())
      .toContain(`/tx/${encodeURIComponent(depositTx()?.id ?? "")}`);
    await expect.poll(() => page.locator(".page-head h1").innerText()).toBe("deposit");

    await page.keyboard.press("/");
    await page.keyboard.type("swaps 1,000");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.locator(".page-head h1").innerText())
      .toContain("swaps 1,000 USDC");
    await closeClean(opened);
  });

  test("a frame is a deep link; the tree and the inspector follow the keyboard", async () => {
    const tx = revertedTx();
    const opened = await open(`#/run/showcase/tx/${tx?.id}?frame=0.0`, 1440);
    const { page } = opened;
    await expect.poll(() => page.locator(".inspector header").innerText()).toContain("frame 0.0");
    await page.keyboard.press("j");
    await expect.poll(() => page.url()).toContain("frame=0.0.0");
    await expect.poll(() => page.locator(".inspector header").innerText()).toContain("frame 0.0.0");
    // h collapses an open frame, then moves to its caller; l opens it again.
    await page.keyboard.press("h");
    await expect.poll(() => page.locator(".trace-rows .row").count()).toBe(3);
    await page.keyboard.press("h");
    await expect.poll(() => page.url()).toMatch(/frame=0\.0$/);
    await page.keyboard.press("h");
    await expect.poll(() => page.locator(".trace-rows .row").count()).toBe(2);
    await page.keyboard.press("l");
    await expect.poll(() => page.locator(".trace-rows .row").count()).toBeGreaterThan(2);
    // A click on the gas icicle selects that frame.
    await page.locator(".ic").first().click();
    await expect.poll(() => page.url()).toMatch(/frame=0$/);
    await closeClean(opened);
  });

  test("copy as code: forkit and viem snippets that reproduce the transaction", async () => {
    const opened = await open(`#/run/showcase/tx/${depositTx()?.id}`, 1440);
    const { page } = opened;
    await page.getByRole("button", { name: "Copy as code" }).click();
    const dialog = page.locator("dialog[open]");
    await expect.poll(() => dialog.innerText()).toContain("describeFork(");
    const text = await dialog.innerText();
    expect(text).toContain("await f.deal(");
    expect(text).toContain("createTestClient(");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator("dialog[open]").count()).toBe(0);
    await closeClean(opened);
  });

  test(`a run with ${LARGE_TXS} transactions renders only the rows in view, and scrolls to the last`, async () => {
    const started = Date.now();
    const opened = await open("#/run/large", 1440);
    const { page } = opened;
    const loadMs = Date.now() - started;
    const rows = await page.locator(".tx-list .row").count();
    expect(rows, "virtualised: a window of rows, not all of them").toBeLessThan(120);
    expect(loadMs, "opens in well under a few seconds").toBeLessThan(5_000);
    await evaluate(page, "document.querySelector('.tx-list').scrollTop = 1e9");
    await expect
      .poll(() => page.locator(`.tx-list .row[data-index="${LARGE_TXS - 1}"]`).count())
      .toBe(1);
    // The timeline of the test that now holds them all is virtualised too.
    const test = run.tests.find((t) => t.name.startsWith("bridges"));
    await page.goto(`${server.url}#/run/large/test/${encodeURIComponent(test?.key ?? "")}`);
    await page.locator(".steps").waitFor();
    expect(await page.locator(".steps .row").count()).toBeLessThan(120);
    // j walks past the rendered window.
    for (let i = 0; i < 60; i++) await page.keyboard.press("j");
    await expect
      .poll(() => page.locator('.steps .row.is-selected[data-index="59"]').count())
      .toBe(1);
    await page.screenshot({ path: join(OUT, "explore-large-1440-light.png") });
    await closeClean(opened);
  });
});
