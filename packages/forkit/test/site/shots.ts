/**
 * Explorer screenshots for the site (site/public/explore), run by site/tools/build-assets.ts:
 * `bun test/site/shots.ts <out dir>`. Viewport-sized (not full-page) captures of the showcase
 * run record, so each one reads as a single screen on the page. Each is framed on the feature it
 * is there to show, and the script fails when a view no longer puts that feature at the top of
 * the screen:
 *
 * - explore-tx-1440.png: a swap's call tree, with a gas bar on every frame, events where they
 *   fired, and the inspector for the selected frame.
 * - explore-1440.png: the run overview, failures first.
 * - explore-test-390.png: a test's timeline on a phone.
 */
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import type { RunRecord } from "../../src/explore/schema.ts";
import { startExploreServer } from "../../src/explore/server.ts";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: bun test/site/shots.ts <out dir>");
const FIXTURE = resolve(import.meta.dirname, "../fixtures/explore/showcase.json");

/** Space above a panel that a shot scrolls to. */
const PAD = 12;

interface Shot {
  name: string;
  hash: string;
  width: number;
  /** The panel the shot is for: it has to end up in the top half of the screen. */
  feature: string;
  /** Scroll the feature to the top of the screen first, for a view with no deep link to it. */
  scroll?: true;
}

const server = await startExploreServer({ files: [FIXTURE] });
const browser = await chromium.launch();
try {
  const run = (await (await fetch(`${server.url}api/runs/showcase`)).json()) as RunRecord;
  // The swap has the richest call tree in the record: ten frames, three call types, events inline.
  const swap = run.txs.find((t) => t.call?.name === "exactInputSingle" && t.status === "success");
  const bridgeTest = run.tests.find((t) => t.name.startsWith("bridges"));
  if (swap === undefined || bridgeTest === undefined) {
    throw new Error("the showcase record has no bridge test or swap");
  }
  const shots: Shot[] = [
    {
      name: "explore-tx-1440.png",
      // `?section=trace` opens a transaction scrolled to its call tree.
      hash: `#/run/showcase/tx/${swap.id}?section=trace`,
      width: 1440,
      feature: "#trace",
    },
    { name: "explore-1440.png", hash: "#/run/showcase", width: 1440, feature: "#failures" },
    {
      name: "explore-test-390.png",
      hash: `#/run/showcase/test/${bridgeTest.key}`,
      width: 390,
      feature: "#timeline",
      // On a phone the tiles above the timeline take half the screen: scroll past them.
      scroll: true,
    },
  ];
  for (const shot of shots) {
    const phone = shot.width < 600;
    const height = phone ? 844 : 900;
    const context = await browser.newContext({
      viewport: { width: shot.width, height },
      deviceScaleFactor: 2,
      colorScheme: "light",
      // The explorer prints times in the browser's locale and zone: pin both, so the PNGs do not
      // depend on the machine that made them.
      locale: "en-US",
      timezoneId: "UTC",
    });
    const page = await context.newPage();
    await page.goto(`${server.url}${shot.hash}`);
    await page.locator(".page-head h1").first().waitFor();
    await page.waitForLoadState("networkidle");
    // Scripts are strings: this file is typed without the DOM library.
    const feature = `document.querySelector(${JSON.stringify(shot.feature)})`;
    if (shot.scroll) {
      await page.evaluate(
        `window.scrollTo(0, ${feature}.getBoundingClientRect().top + scrollY - ${PAD})`,
      );
    }
    await page
      .waitForFunction(
        `(() => {
          const box = ${feature}?.getBoundingClientRect();
          return box !== undefined && box.top >= 0 && box.top <= ${height / 2};
        })()`,
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => {
        throw new Error(`${shot.name}: ${shot.feature} is not at the top of the screen`);
      });
    await page.screenshot({ path: join(out, shot.name) });
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
