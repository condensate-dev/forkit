/**
 * Explorer screenshots for the site (site/public/explore), run by site/tools/build-assets.ts:
 * `bun test/site/shots.ts <out dir>`. Viewport-sized (not full-page) captures of the showcase
 * run record, so each one reads as a single screen on the page.
 */
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import type { RunRecord } from "../../src/explore/schema.ts";
import { startExploreServer } from "../../src/explore/server.ts";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: bun test/site/shots.ts <out dir>");
const FIXTURE = resolve(import.meta.dirname, "../fixtures/explore/showcase.json");

const server = await startExploreServer({ files: [FIXTURE] });
const browser = await chromium.launch();
try {
  const run = (await (await fetch(`${server.url}api/runs/showcase`)).json()) as RunRecord;
  const deposit = run.txs.find((t) => t.call?.name === "deposit" && t.status === "success");
  const bridgeTest = run.tests.find((t) => t.name.startsWith("bridges"));
  if (deposit === undefined || bridgeTest === undefined) {
    throw new Error("the showcase record has no bridge test or deposit");
  }
  const shots = [
    { name: "explore-tx-1440.png", hash: `#/run/showcase/tx/${deposit.id}`, width: 1440 },
    { name: "explore-1440.png", hash: "#/run/showcase", width: 1440 },
    { name: "explore-test-390.png", hash: `#/run/showcase/test/${bridgeTest.key}`, width: 390 },
  ];
  for (const shot of shots) {
    const phone = shot.width < 600;
    const context = await browser.newContext({
      viewport: { width: shot.width, height: phone ? 844 : 900 },
      deviceScaleFactor: 2,
      colorScheme: "light",
    });
    const page = await context.newPage();
    await page.goto(`${server.url}${shot.hash}`);
    await page.locator(".page-head h1").first().waitFor();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: join(out, shot.name) });
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
