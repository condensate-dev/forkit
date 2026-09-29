/**
 * The reporter end to end: real fork suites run in child processes through the vitest reporter
 * (setup file + reporter), the bun preload, and the node:test recipe; the output must carry the
 * boot line, per-test tables with signed deltas, bridge line, gas diff and decoded failure traces.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "forkit-reporter-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The parent's env minus vitest's own markers, plus plain output and fork settings. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("VITEST") && key !== "TEST" && key !== "FORCE_COLOR") env[key] = value;
  }
  return { ...env, NO_COLOR: "1", FORKIT_CACHE: "off", ...extra };
}

function run(
  command: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  return new Promise((ok) => {
    execFile(
      command,
      args,
      { cwd: root, env: childEnv(env), timeout: 150_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        ok({ code, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

/** The forkit section of a run's output, from its title to the end. */
function section(output: string, title: string): string {
  const at = output.indexOf(`forkit · ${title}`);
  expect(at, `no "forkit · ${title}" in:\n${output}`).toBeGreaterThanOrEqual(0);
  return output.slice(at);
}

const BOOT = /⛓ Foundry \(31337\) · block 0 · 127\.0\.0\.1:\d+ · no cache · booted in \d/;

describe("reporter", { timeout: 180_000 }, () => {
  test("vitest: setup file + reporter print the run per file", async () => {
    const snapshot = join(dir, ".gas-snapshot");
    writeFileSync(snapshot, "coin transfer (gas: 50000)\n");
    const { code, output } = await run(
      join(root, "node_modules/.bin/vitest"),
      ["run", "--config", "test/anvil/reporter/vitest.config.ts"],
      { FORKIT_GAS_SNAPSHOT: "write", FORKIT_GAS_SNAPSHOT_FILE: snapshot },
    );
    expect(code, output).toBe(1); // two tests fail on purpose
    expect(output).toMatch(/Tests +2 failed \| 2 passed \(4\)/);
    expect(output).not.toContain("Failed Suites");
    const text = section(output, "test/anvil/reporter/suite.fixture.ts");
    expect(text).not.toContain("\u001b[");
    // Boot lines for both chains.
    expect(text).toMatch(BOOT);
    expect(text).toMatch(/⛓ Other \(31338\) · block 0 · 127\.0\.0\.1:\d+ · no cache/);
    // Per-test summary: txs, gas, and signed balance changes with token decimals.
    expect(text).toMatch(/✓ coin › pays bob in coins and ether {2}3 txs · [\d,]+ gas · \d/);
    expect(text).toMatch(/balance change +TCOIN +ETH\n/);
    expect(text).toMatch(/deployer +-1,000 +-0\.0\d+…?\n/);
    expect(text).toMatch(/alice +\+749\.5 +-1\.000\d+…\n/);
    expect(text).toMatch(/bob +\+250\.5 +\+1\n/);
    // The bridge simulator's fill.
    expect(text).toMatch(
      /⇄ toy deposit 31337:0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}:0 · Foundry → Other · fill 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4} · fee 0\.5 TCOIN · settled 99\.5 TCOIN/,
    );
    // A failed expectRevert: decoded trace, expected vs actual.
    expect(text).toContain("✗ coin › rejects a zero deposit with the right reason");
    expect(text).toMatch(
      /\[\d+\] Vault::deposit\(\)\n\s+└─ ← \[Revert\] Error\("Vault: zero deposit"\)/,
    );
    expect(text).toContain("- expected  Vault: nothing to deposit");
    expect(text).toContain('+ actual    Error("Vault: zero deposit")');
    // An uncaught revert: the decoded custom error with labels.
    expect(text).toContain("✗ coin › withdraws more than it holds");
    expect(text).toMatch(
      /Vault::withdraw\(alice \(0x0000…11cE\), 2000000000000000000\)\n\s+└─ ← \[Revert\] InsufficientBalance\(alice \(0x0000…11cE\), 0, 2000000000000000000\)/,
    );
    // Events after the last test (a describeFork afterAll) come through the file's meta.
    const after = text.slice(text.indexOf("✗ coin › withdraws more than it holds"));
    expect(after).toMatch(/· \(outside tests\) {2}1 tx · [\d,]+ gas\n/);
    expect(after).toMatch(/escrow +\+1\n/);
    // The gas snapshot diff against the committed file.
    expect(text).toMatch(/coin transfer +50,000 +[\d,]+ +\+[\d,]+ +\+[\d.]+%/);
  });

  test("bun: the preload prints the run after the last test", async () => {
    const { code, output } = await run("bun", [
      "test",
      "--preload",
      "./src/reporter/bun.ts",
      "./test/anvil/reporter/bun-suite.fixture.test.ts",
    ]);
    expect(code, output).toBe(1);
    const text = section(output, "bun test");
    expect(text).not.toContain("\u001b[");
    expect(text).toMatch(BOOT);
    expect(text).toMatch(/✓ coin › pays bob in coins {2}1 tx · [\d,]+ gas/);
    expect(text).toMatch(/bob +\+42\.25\n/);
    expect(text).toContain("✗ coin › withdraws more than it holds");
    expect(text).toMatch(/└─ ← \[Revert\] InsufficientBalance\(alice \(0x0000…11cE\), 0, /);
  });

  test("node:test: collectRun() + formatRun() in the file", async () => {
    const { code, output } = await run("node", [
      "--test",
      "--test-reporter=spec",
      "test/anvil/reporter/node-suite.fixture.ts",
    ]);
    expect(code, output).toBe(1);
    const text = section(output, "node:test");
    expect(text).toMatch(BOOT);
    expect(text).toMatch(/bob +\+42\.25\n/);
    expect(text).toMatch(/└─ ← \[Revert\] InsufficientBalance\(alice \(0x0000…11cE\), 0, /);
  });
});
