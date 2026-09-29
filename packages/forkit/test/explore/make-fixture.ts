/**
 * Regenerate test/fixtures/explore/showcase.json: run showcase.fixture.ts with recording on,
 * against a scratch copy of the fork recordings (so the committed ones never change), and keep
 * the merged run record with machine-specific paths removed.
 *
 *   bun run explore:fixture            (needs network only for state the recordings lack)
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRun } from "../../src/explore/store.ts";

const pkg = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "forkit-showcase-"));
cpSync(join(pkg, ".forkit-cache"), join(scratch, "cache"), { recursive: true });
const result = spawnSync("npx", ["vitest", "run", "--project", "explore-fixture"], {
  cwd: pkg,
  stdio: "inherit",
  env: {
    ...process.env,
    FORKIT_RECORD: "1",
    FORKIT_RECORD_DIR: join(scratch, "record"),
    FORKIT_RUN_ID: "showcase",
    SHOWCASE_CACHE_DIR: join(scratch, "cache"),
    FORKIT_GAS_SNAPSHOT: "write",
    FORKIT_GAS_SNAPSHOT_FILE: join(scratch, ".gas-snapshot"),
  },
});
// One test fails on purpose, so a non-zero exit is expected; a missing record is not.
const run = readRun(join(scratch, "record"), "showcase");
if (run === undefined) throw new Error(`no run recorded (vitest exit ${result.status})`);
const clean = JSON.parse(
  JSON.stringify(run).replaceAll(pkg, "<forkit>").replaceAll(scratch, "<scratch>"),
) as typeof run;
for (const worker of clean.workers)
  worker.argv = worker.argv.map((a) => a.replace(/^.*\/node_modules\//, ""));
const out = join(pkg, "test/fixtures/explore/showcase.json");
mkdirSync(join(pkg, "test/fixtures/explore"), { recursive: true });
writeFileSync(out, `${JSON.stringify(clean, null, 1)}\n`);
rmSync(scratch, { recursive: true, force: true });
console.log(
  `wrote ${out}: ${run.tests.length} tests, ${run.txs.length} txs, ${run.fills.length} fills (${readFileSync(out).length} bytes)`,
);
