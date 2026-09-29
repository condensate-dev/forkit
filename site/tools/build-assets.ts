/**
 * Regenerate the generated parts of site/forkit: `bun site/tools/build-assets.ts`.
 *
 * 1. Explorer screenshots: packages/forkit/test/site/shots.ts captures three views of the
 *    committed showcase run record (Playwright's Chromium, 2x) into site/forkit/assets, then each
 *    <img>'s width and height are set from the PNG, in CSS pixels.
 * 2. Terminal output: runs the Base → Arbitrum Across e2e offline (FORKIT_CACHE=offline, the
 *    committed recording) with forkit's reporter and FORCE_COLOR=1, turns the report's ANSI
 *    colours into spans, and inlines it between the terminal markers in index.html.
 *
 * Needs anvil on PATH and `npx playwright install chromium` in packages/forkit.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const PKG = join(ROOT, "packages/forkit");
const SITE = join(ROOT, "site/forkit");
const INDEX = join(SITE, "index.html");
const SHOTS = ["explore-tx-1440.png", "explore-1440.png", "explore-test-390.png"];

function run(command: string, args: string[], env: Record<string, string>): string {
  const result = spawnSync(command, args, {
    cwd: PKG,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return result.stdout + result.stderr;
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const OPEN: Record<string, string> = {
  "1": "t-bold",
  "2": "t-dim",
  "31": "t-red",
  "32": "t-green",
  "33": "t-yellow",
  "35": "t-magenta",
  "36": "t-cyan",
};
const CLOSE = new Set(["22", "39", "0"]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
const SGR = /\u001b\[(\d+)m/g;

/** The reporter's ANSI (the codes in src/reporter/ansi.ts) as nested spans. */
export function ansiToHtml(text: string): string {
  let html = "";
  let open = 0;
  // split() with a capture group: text at even indices, SGR codes at odd ones.
  text.split(SGR).forEach((part, i) => {
    if (i % 2 === 0) html += escapeHtml(part);
    else if (OPEN[part] !== undefined) {
      html += `<span class="${OPEN[part]}">`;
      open++;
    } else if (CLOSE.has(part) && open > 0) {
      html += "</span>";
      open--;
    }
  });
  return html + "</span>".repeat(open);
}

// 1. Explorer screenshots, captured at 2x.
run("bun", ["test/site/shots.ts", join(SITE, "assets")], {});
let html = readFileSync(INDEX, "utf8");
for (const name of SHOTS) {
  const { width, height } = pngSize(join(SITE, "assets", name));
  const tag = new RegExp(`(<img src="assets/${name}"[^>]*?)width="\\d+" height="\\d+"`);
  if (!tag.test(html)) throw new Error(`index.html has no <img> for ${name}`);
  html = html.replace(tag, `$1width="${width / 2}" height="${height / 2}"`);
}

// 2. Terminal output, from the first "forkit ·" line of the report to its end.
const output = run("npx", ["vitest", "run", "--config", join(PKG, "test/site/vitest.config.ts")], {
  FORKIT_CACHE: "offline",
  FORCE_COLOR: "1",
});
const lines = output.split("\n");
const plain = (line: string) => line.replace(SGR, "");
const start = lines.findIndex((line) => plain(line).startsWith("forkit ·"));
if (start === -1) throw new Error("the reporter printed no forkit block");
let end = lines.length;
while (end > start && plain(lines[end - 1] ?? "").trim() === "") end--;
const report = lines.slice(start, end).join("\n");
const block = `<!-- terminal:start -->\n<pre class="term-body"><code>${ansiToHtml(report)}</code></pre>\n<!-- terminal:end -->`;
html = html.replace(/<!-- terminal:start -->[\s\S]*?<!-- terminal:end -->/, block);

writeFileSync(INDEX, html);
console.log(`site/forkit: ${SHOTS.length} screenshots, ${end - start} lines of terminal output.`);
