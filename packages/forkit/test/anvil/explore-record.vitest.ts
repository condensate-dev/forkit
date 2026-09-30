/**
 * `FORKIT_RECORD=1` end to end on real anvil: run a small two-file fork suite (test/explore/suite)
 * in a child vitest, so two worker processes record, then read the merged run record.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { RunRecord, TraceFrame } from "../../src/explore/schema.ts";
import { listRuns, readRun } from "../../src/explore/store.ts";
import { startUpstream } from "./upstream.ts";

const SUITE = resolve(import.meta.dirname, "../explore/suite");
const vitestBin = join(
  dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);
const dir = mkdtempSync(join(tmpdir(), "forkit-record-"));
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let run: RunRecord;
let exitCode: number | null;
let output: string;

beforeAll(async () => {
  upstream = await startUpstream();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORKIT_RECORD: "1",
    FORKIT_RECORD_DIR: dir,
    EXPLORE_SUITE_UPSTREAM: upstream.url,
  };
  delete env.FORKIT_RUN_ID;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  const child = spawnSync(
    process.execPath,
    [vitestBin, "run", "--config", join(SUITE, "vitest.config.ts"), "--root", SUITE],
    {
      env,
      encoding: "utf8",
      timeout: 90_000,
    },
  );
  exitCode = child.status;
  output = `${child.stdout}\n${child.stderr}`;
  const runs = listRuns(dir);
  expect(runs, output).toHaveLength(1);
  run = readRun(dir, runs[0]?.id as string) as RunRecord;
}, 120_000);

afterAll(async () => {
  await upstream?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const find = (
  predicate: (frame: TraceFrame) => boolean,
  frame: TraceFrame | undefined,
): TraceFrame | undefined => {
  if (frame === undefined) return undefined;
  if (predicate(frame)) return frame;
  for (const child of frame.calls ?? []) {
    const hit = find(predicate, child);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

test("the suite ran: one failure on purpose, everything else passed", () => {
  expect(exitCode, output).toBe(1);
  expect(output).toContain("4 passed");
});

test("both workers wrote parts of one run, merged into runs/<id>.json", () => {
  expect(
    readdirSync(join(dir, "parts", run.id)).filter((f) => f.endsWith(".jsonl")).length,
  ).toBeGreaterThanOrEqual(2);
  expect(readdirSync(join(dir, "runs"))).toContain(`${run.id}.json`);
  expect(run.forks.length).toBeGreaterThanOrEqual(2);
  expect(run.forks.every((f) => f.chainId === 31_337 && f.blockNumber === "0")).toBe(true);
});

test("records every test with its suite and outcome", () => {
  const byName = Object.fromEntries(run.tests.map((t) => [t.name, t]));
  expect(Object.keys(byName).sort()).toEqual([
    "a zero deposit reverts before it is mined",
    "a zero deposit with explicit gas is mined, reverted",
    "alice deposits 1 ether",
    "alice withdraws to bob",
    "fails on purpose, so the record has a failure",
  ]);
  expect(byName["alice deposits 1 ether"]).toMatchObject({
    suite: "Vault deposits",
    status: "pass",
  });
  expect(byName["fails on purpose, so the record has a failure"]).toMatchObject({
    suite: "Vault withdrawals",
    status: "fail",
  });
  expect(byName["fails on purpose, so the record has a failure"]?.error).toContain(
    "bob starts empty",
  );
  // The failed expectation's values, for the explorer's expected-vs-actual diff.
  expect(byName["fails on purpose, so the record has a failure"]).toMatchObject({
    actual: expect.any(String),
    expected: expect.any(String),
  });
});

test("mined transactions carry receipts, decoded calls, events, traces and balance changes", () => {
  const test = run.tests.find((t) => t.name === "alice deposits 1 ether");
  const [deposit] = run.txs.filter((t) => t.test === test?.key);
  expect(deposit).toMatchObject({
    mined: true,
    status: "success",
    kind: "writeContract",
    call: { name: "deposit", signature: "deposit()" },
    value: "1000000000000000000",
  });
  expect(BigInt(deposit?.gasUsed ?? "0")).toBeGreaterThan(21_000n);
  expect(deposit?.blockNumber).toBeDefined();
  expect(deposit?.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(deposit?.logs.map((l) => l.event?.name)).toEqual(["Deposited"]);
  // Vault.deposit → Ledger.record, decoded.
  expect(deposit?.trace?.call?.name).toBe("deposit");
  expect(find((f) => f.call?.name === "record", deposit?.trace)).toBeDefined();
  const vault = deposit?.to as string;
  expect(run.labels[vault]).toBe("Vault");
  expect(deposit?.balanceChanges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        address: vault,
        token: "native",
        delta: "1000000000000000000",
        after: "1000000000000000000",
      }),
    ]),
  );
  // Setup (beforeAll) transactions belong to no test.
  expect(
    run.txs.some(
      (t) => t.kind === "deployContract" && t.test === undefined && t.contractAddress !== undefined,
    ),
  ).toBe(true);
  expect(run.deals.some((d) => d.token === "native" && d.test === test?.key)).toBe(true);
  // Events at the frame that emitted them.
  expect(
    find((f) => (f.logs ?? []).some((l) => l.event?.name === "Deposited"), deposit?.trace),
  ).toBeDefined();
  // State before and after: the vault's ether, and alice's slot in its balances mapping.
  const vaultDiff = deposit?.stateDiff?.find((a) => a.address === vault);
  expect(vaultDiff?.balance).toEqual({ before: "0", after: "1000000000000000000" });
  expect(
    deposit?.stateDiff?.some((a) => a.storage.some((s) => /\[alice\]/.test(s.hint ?? ""))),
  ).toBe(true);
  // The prank around the deposit is on the timeline; the per-test isolation snapshot is not.
  const cheats = (run.cheats ?? []).filter((c) => c.test === test?.key).map((c) => c.cheat);
  expect(cheats).toEqual(["prank", "stopPrank"]);
  expect((run.cheats ?? []).some((c) => c.cheat === "snapshot" || c.cheat === "revert")).toBe(
    false,
  );
});

test("a revert at estimation has a decoded trace and reason", () => {
  const test = run.tests.find((t) => t.name === "a zero deposit reverts before it is mined");
  const [reverted] = run.txs.filter((t) => t.test === test?.key);
  expect(reverted).toMatchObject({
    mined: false,
    status: "reverted",
    revert: 'Error("Vault: zero deposit")',
  });
  expect(reverted?.trace).toMatchObject({
    call: { name: "deposit" },
    revert: 'Error("Vault: zero deposit")',
  });
  expect(reverted?.traceText).toContain("Vault: zero deposit");
});

test("a mined revert has its receipt and trace, read before the test's evm_revert", () => {
  const test = run.tests.find(
    (t) => t.name === "a zero deposit with explicit gas is mined, reverted",
  );
  const [mined] = run.txs.filter((t) => t.test === test?.key);
  expect(mined).toMatchObject({
    mined: true,
    status: "reverted",
    revert: 'Error("Vault: zero deposit")',
  });
  expect(mined?.hash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(mined?.notes).toBeUndefined();
});

test("a withdrawal's trace shows the ether reaching bob, and bob's balance after", () => {
  const test = run.tests.find((t) => t.name === "alice withdraws to bob");
  const withdraw = run.txs.find((t) => t.test === test?.key && t.call?.name === "withdraw");
  expect(withdraw?.call?.args).toEqual([
    { name: "to", type: "address", value: expect.stringMatching(/^0x0+b0b$/i) },
    { name: "amount", type: "uint256", value: "1000000000000000000" },
  ]);
  expect(withdraw?.balanceChanges).toEqual(
    expect.arrayContaining([
      {
        address: "0x0000000000000000000000000000000000000b0b",
        token: "native",
        delta: "1000000000000000000",
        after: "1000000000000000000",
      },
    ]),
  );
  expect(withdraw?.logs[0]?.event?.name).toBe("Withdrawn");
});
