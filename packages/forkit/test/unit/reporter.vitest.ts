import { type Address, type Hex, pad, toHex } from "viem";
import { describe, expect, test } from "vitest";
import { emitForkitEvent } from "../../src/events.ts";
import type {
  BridgeFillEvent,
  ForkBootEvent,
  ForkitEvent,
  GasSnapshotEvent,
  TestEndEvent,
  TxMinedEvent,
  TxRevertedEvent,
  TxSentEvent,
} from "../../src/index.ts";
import { clearLabels, label } from "../../src/index.ts";
import {
  balanceChanges,
  collectRun,
  diffLines,
  ForkitReporter,
  formatAmount,
  formatBootLine,
  formatBridgeLine,
  formatFailure,
  formatGasTable,
  formatRun,
  META_KEY,
  mergeRunLogs,
  palette,
  parseRunLog,
  type RenderContext,
  type RunLog,
  serializeRunLog,
  shouldColor,
  stripAnsi,
  testEvents,
} from "../../src/reporter/index.ts";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const alice: Address = "0x00000000000000000000000000000000000a11ce";
const bob: Address = "0x0000000000000000000000000000000000000b0b";
const router: Address = "0x000000000000000000000000000000000000beef";
const usdc: Address = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const arbUsdc: Address = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

const topic = (address: Address): Hex => pad(address, { size: 32 });
const transfer = (token: Address, from: Address, to: Address, amount: bigint, logIndex = 0) => ({
  address: token,
  topics: [TRANSFER, topic(from), topic(to)] as Hex[],
  data: toHex(amount, { size: 32 }),
  logIndex,
});

const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
let ts = 1_000;
const at = () => ts++;

const boot: ForkBootEvent = {
  type: "fork:boot",
  ts: at(),
  chainId: 8453,
  chainName: "Base",
  blockNumber: 21_000_000n,
  upstream: "https://base-mainnet.example.com/v2/<redacted>",
  rpcUrl: "http://127.0.0.1:61001",
  cache: {
    path: "/tmp/cache.json",
    mode: "readwrite",
    hits: 412,
    misses: 0,
    entries: 412,
    missesByMethod: {},
  },
  bootMs: 812,
};
const arbBoot: ForkBootEvent = {
  type: "fork:boot",
  ts: at(),
  chainId: 42161,
  chainName: "Arbitrum One",
  blockNumber: 250_000_000n,
  upstream: "https://arb1.example.org/?key=<redacted>",
  rpcUrl: "http://127.0.0.1:61002",
  bootMs: 1450,
};

const swapSent: TxSentEvent = {
  type: "tx:sent",
  ts: at(),
  chainId: 8453,
  rpcUrl: boot.rpcUrl,
  hash: hash(1),
  kind: "sendTransaction",
  from: alice,
  to: router,
  value: 10n ** 16n,
};
const swapMined: TxMinedEvent = {
  type: "tx:mined",
  ts: at(),
  chainId: 8453,
  rpcUrl: boot.rpcUrl,
  hash: hash(1),
  status: "success",
  from: alice,
  to: router,
  blockNumber: 21_000_001n,
  gasUsed: 184_221n,
  effectiveGasPrice: 1_000_000_000n,
  logs: [
    transfer(usdc, alice, router, 1_000_000_000n),
    transfer(usdc, router, bob, 250_500_000n, 1),
  ],
};

const reverted: TxRevertedEvent = {
  type: "tx:reverted",
  ts: at(),
  chainId: 8453,
  rpcUrl: boot.rpcUrl,
  kind: "writeContract",
  from: alice,
  to: router,
  functionName: "withdraw",
  message: 'The contract function "withdraw" reverted.',
  trace: [
    "[24791] Router::withdraw(alice, 2000000)",
    "  ├─ [2412] USDC::balanceOf(Router) [staticcall]",
    "  │   └─ ← [Return] 0",
    '  └─ ← [Revert] Error("Router: empty")',
  ].join("\n"),
};

const fill: BridgeFillEvent = {
  type: "bridge:fill",
  ts: at(),
  bridge: "across",
  depositId: `8453:${hash(7)}:3`,
  originChainId: 8453,
  destinationChainId: 42161,
  depositTxHash: hash(7),
  txHashes: [hash(8)],
  outputAmount: 99_500_000n,
  details: { fee: 500_000n, relayer: router },
};
const fillMined: TxMinedEvent = {
  type: "tx:mined",
  ts: at(),
  chainId: 42161,
  rpcUrl: arbBoot.rpcUrl,
  hash: hash(8),
  status: "success",
  from: router,
  to: arbUsdc,
  blockNumber: 250_000_001n,
  gasUsed: 90_000n,
  effectiveGasPrice: 10_000_000n,
  logs: [transfer(arbUsdc, router, alice, 99_500_000n)],
};

const gas = (label: string, gas: bigint, previous?: bigint): GasSnapshotEvent => ({
  type: "gas:snapshot",
  ts: at(),
  label,
  gas,
  mode: "check",
  file: "/repo/.gas-snapshot",
  ...(previous === undefined ? {} : { previous }),
});

const start = (testId: number, name: string): ForkitEvent => ({
  type: "test:start",
  ts: at(),
  testId,
  suite: "swap",
  name,
});
const end = (testId: number, name: string, extra: Partial<TestEndEvent> = {}): TestEndEvent => ({
  type: "test:end",
  ts: at(),
  testId,
  suite: "swap",
  name,
  status: "pass",
  durationMs: 41,
  ...extra,
});

const failedEnd = end(2, "withdraws from an empty router", {
  status: "fail",
  durationMs: 1234,
  error: `The contract function "withdraw" reverted.\n\nContract Call:\n  address: ${router}\n\nTrace (forkit, replayed with debug_traceCall):\n  ${reverted.trace?.split("\n").join("\n  ")}`,
  actual: "0",
  expected: "2000000",
});

const run: RunLog = {
  events: [
    boot,
    arbBoot,
    start(1, "swaps ETH for USDC and pays bob"),
    swapSent,
    swapMined,
    gas("swap", 184_221n, 180_000n),
    end(1, "swaps ETH for USDC and pays bob"),
    start(2, "withdraws from an empty router"),
    reverted,
    failedEnd,
    start(3, "bridges USDC to Arbitrum"),
    fillMined,
    fill,
    gas("bridge", 90_000n, 95_000n),
    gas("approve", 46_000n, 46_000n),
    gas("permit", 51_000n),
    end(3, "bridges USDC to Arbitrum"),
  ],
  labels: { [alice]: "alice", [bob]: "bob", [router]: "Router" },
  tokens: {
    [`8453:${usdc}`]: { symbol: "USDC", decimals: 6 },
    [`42161:${arbUsdc}`]: { symbol: "USDC", decimals: 6 },
  },
};

const plain = palette(false);
const ctx = (log: RunLog = run): RenderContext => ({
  c: plain,
  labels: log.labels,
  tokens: log.tokens,
  chains: new Map([
    [8453, { name: "Base", native: "ETH" }],
    [42161, { name: "Arbitrum One", native: "ETH" }],
  ]),
  cwd: "/repo",
});

describe("colour", () => {
  test("NO_COLOR wins, then FORCE_COLOR; CI, dumb terminals and pipes get plain text", () => {
    const tty = { isTTY: true };
    const pipe = { isTTY: false };
    expect(shouldColor(tty, {})).toBe(true);
    expect(shouldColor(pipe, {})).toBe(false);
    expect(shouldColor(tty, { NO_COLOR: "1" })).toBe(false);
    expect(shouldColor(tty, { NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
    expect(shouldColor(tty, { NO_COLOR: "" })).toBe(true);
    expect(shouldColor(pipe, { FORCE_COLOR: "1" })).toBe(true);
    expect(shouldColor(tty, { FORCE_COLOR: "0" })).toBe(false);
    expect(shouldColor(tty, { CI: "true" })).toBe(false);
    expect(shouldColor(tty, { CI: "false" })).toBe(true);
    expect(shouldColor(tty, { TERM: "dumb" })).toBe(false);
  });

  test("colour output is the plain output plus ANSI escapes", () => {
    const colored = formatRun(run, { color: true, cwd: "/repo" });
    const text = formatRun(run, { color: false, cwd: "/repo" });
    expect(colored).toContain("\u001b[");
    expect(text).not.toContain("\u001b[");
    expect(stripAnsi(colored)).toBe(text);
  });

  test("deltas are red when negative and green when positive; gas increases red", () => {
    const colored = formatRun(run, { color: true, cwd: "/repo" });
    expect(colored).toContain("\u001b[31m-1,000\u001b[39m");
    expect(colored).toContain("\u001b[32m+250.5\u001b[39m");
    expect(colored).toContain("\u001b[31m+4,221\u001b[39m");
    expect(colored).toContain("\u001b[32m-5,000\u001b[39m");
  });

  test("NO_COLOR in the environment turns colour off by default", () => {
    const saved = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      expect(formatRun(run, { cwd: "/repo" })).not.toContain("\u001b[");
    } finally {
      if (saved === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved;
    }
  });
});

describe("amounts", () => {
  test("decimals, digit groups, signs, and a marked cut past 6 decimals", () => {
    expect(formatAmount(1_000_000_000n, 6, true)).toBe("+1,000");
    expect(formatAmount(-250_500_000n, 6, true)).toBe("-250.5");
    expect(formatAmount(1_234_567_891n, 0)).toBe("1,234,567,891");
    expect(formatAmount(1_234_567_891n)).toBe("1,234,567,891");
    expect(formatAmount(10n ** 18n + 1n, 18, true)).toBe("+1…");
    expect(formatAmount(-184_221_000_000_000n, 18, true)).toBe("-0.0001842…");
    expect(formatAmount(109_222n, 6)).toBe("0.109222");
    expect(formatAmount(370_951_843_244_140_674n, 18)).toBe("0.370951…");
    expect(formatAmount(1_500_000_000_000_000_000n, 18)).toBe("1.5");
    expect(formatAmount(0n, 6, true)).toBe("0");
  });
});

describe("boot line", () => {
  test("chain, block, host with secrets masked, cache and boot time", () => {
    expect(formatBootLine(boot, ctx())).toBe(
      "⛓ Base (8453) · block 21,000,000 · base-mainnet.example.com · cache hit (412 reads) · booted in 812 ms",
    );
    expect(formatBootLine(arbBoot, ctx())).toBe(
      "⛓ Arbitrum One (42161) · block 250,000,000 · arb1.example.org · no cache · booted in 1.45 s",
    );
  });

  test("a cache miss says how much went upstream; an unpinned fork says so", () => {
    const miss = {
      ...boot,
      cache: { ...(boot.cache as NonNullable<ForkBootEvent["cache"]>), hits: 10, misses: 3 },
    };
    expect(formatBootLine(miss, ctx())).toContain("cache miss (3 of 13 upstream)");
    const { blockNumber: _, ...live } = boot;
    expect(formatBootLine(live, ctx())).toContain("live head (unpinned)");
  });
});

describe("per-test summary", () => {
  test("balance changes from Transfer logs, native value and gas paid", () => {
    const deltas = balanceChanges([swapMined], [swapSent]);
    expect(Object.fromEntries([...deltas].map(([k, v]) => [k, Object.fromEntries(v)]))).toEqual({
      [alice]: {
        "8453:native": -(10n ** 16n) - 184_221n * 1_000_000_000n,
        [`8453:${usdc}`]: -1_000_000_000n,
      },
      [router]: { "8453:native": 10n ** 16n, [`8453:${usdc}`]: 749_500_000n },
      [bob]: { [`8453:${usdc}`]: 250_500_000n },
    });
  });

  test("a reverted receipt only costs its sender gas", () => {
    const failed: TxMinedEvent = { ...swapMined, status: "reverted", logs: [] };
    const deltas = balanceChanges([failed], [swapSent]);
    expect([...deltas.keys()]).toEqual([alice]);
    expect(deltas.get(alice)?.get("8453:native")).toBe(-184_221n * 1_000_000_000n);
  });

  test("the whole run, plain", () => {
    expect(
      formatRun(run, { color: false, title: "test/swap.vitest.ts", cwd: "/repo" }),
    ).toMatchInlineSnapshot(`
      "forkit · test/swap.vitest.ts
        ⛓ Base (8453) · block 21,000,000 · base-mainnet.example.com · cache hit (412 reads) · booted in 812 ms
        ⛓ Arbitrum One (42161) · block 250,000,000 · arb1.example.org · no cache · booted in 1.45 s
        ✓ swap › swaps ETH for USDC and pays bob  1 tx · 184,221 gas · 41 ms
              balance change    USDC         ETH
              alice           -1,000  -0.010184…
              Router          +749.5       +0.01
              bob             +250.5
        ✗ swap › withdraws from an empty router  1 reverted · 1.23 s
              ✗ The contract function "withdraw" reverted.
              Trace:
                [24791] Router::withdraw(alice, 2000000)
                  ├─ [2412] USDC::balanceOf(Router) [staticcall]
                  │   └─ ← [Return] 0
                  └─ ← [Revert] Error("Router: empty")
              Expected vs actual:
                - expected  2000000
                + actual    0
        ✓ swap › bridges USDC to Arbitrum  1 tx · 90,000 gas · 41 ms
              balance change   USDC         ETH
              Router          -99.5  -0.0000009
              alice           +99.5
              ⇄ across deposit 8453:0x0000…0007:3 · Base → Arbitrum One · fill 0x0000…0008 · fee 0.5 USDC · settled 99.5 USDC

      gas snapshot · .gas-snapshot (check)
        label    snapshot      now       Δ
        approve    46,000   46,000       0
        bridge     95,000   90,000  -5,000  -5.26%
        permit          —   51,000     new
        swap      180,000  184,221  +4,221  +2.34%"
    `);
  });

  test("plain events get this process's labels and raw token units", () => {
    clearLabels();
    label(alice, "alice");
    try {
      const text = formatRun([swapSent, swapMined], { color: false });
      expect(text).toContain("alice");
      expect(text).toContain("-1,000,000,000");
      expect(text).toContain("0x8335…2913");
    } finally {
      clearLabels();
    }
  });
});

describe("failure", () => {
  test("head without viem's call details, the trace, and expected vs actual", () => {
    expect(formatFailure(failedEnd, [reverted], plain).join("\n")).toMatchInlineSnapshot(`
      "✗ The contract function "withdraw" reverted.
      Trace:
        [24791] Router::withdraw(alice, 2000000)
          ├─ [2412] USDC::balanceOf(Router) [staticcall]
          │   └─ ← [Return] 0
          └─ ← [Revert] Error("Router: empty")
      Expected vs actual:
        - expected  2000000
        + actual    0"
    `);
  });

  test("the trace comes from the tx:reverted the error started as, when the message has none", () => {
    const bare = { ...failedEnd, error: 'The contract function "withdraw" reverted.' };
    const lines = formatFailure(bare, [reverted], plain).join("\n");
    expect(lines).toContain('└─ ← [Revert] Error("Router: empty")');
    const other = { ...failedEnd, error: "expected 1 to be 2" };
    expect(formatFailure(other, [reverted], plain).join("\n")).not.toContain("Trace:");
  });

  test("a multi-line diff marks the lines that differ", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { op: " ", line: "a" },
      { op: "-", line: "b" },
      { op: "+", line: "x" },
      { op: " ", line: "c" },
    ]);
    const multi = {
      ...failedEnd,
      error: "mismatch",
      expected: "{\n  a: 1,\n  b: 2\n}",
      actual: "{\n  a: 1,\n  b: 3\n}",
    };
    expect(formatFailure(multi, [], plain).join("\n")).toMatchInlineSnapshot(`
      "✗ mismatch
      Expected (-) vs actual (+):
          {
            a: 1,
        -   b: 2
        +   b: 3
          }"
    `);
  });
});

describe("bridge line", () => {
  test("deposit id, origin → destination, fill tx, fee and settled amount in the delivered token", () => {
    expect(formatBridgeLine(fill, [fillMined], ctx())).toBe(
      "⇄ across deposit 8453:0x0000…0007:3 · Base → Arbitrum One · fill 0x0000…0008 · fee 0.5 USDC · settled 99.5 USDC",
    );
  });

  test("raw units when the delivered token is unknown; extra fill txs are counted", () => {
    const two = { ...fill, txHashes: [hash(8), hash(9)] };
    expect(formatBridgeLine(two, [], ctx())).toBe(
      "⇄ across deposit 8453:0x0000…0007:3 · Base → Arbitrum One · fill 0x0000…0008 (+1 more) · fee 500,000 · settled 99,500,000",
    );
  });
});

describe("gas snapshot diff", () => {
  test("committed value against the latest measurement, sorted by label", () => {
    const events = run.events.filter((e): e is GasSnapshotEvent => e.type === "gas:snapshot");
    expect(
      formatGasTable([...events, gas("swap", 185_000n, 184_221n)], ctx()).join("\n"),
    ).toMatchInlineSnapshot(`
        "gas snapshot · .gas-snapshot (check)
          label    snapshot      now       Δ
          approve    46,000   46,000       0
          bridge     95,000   90,000  -5,000  -5.26%
          permit          —   51,000     new
          swap      180,000  185,000  +5,000  +2.78%"
      `);
  });
});

describe("transport", () => {
  test("a run log survives JSON with its bigints", () => {
    const back = parseRunLog(serializeRunLog(run));
    expect(back).toEqual(run);
    expect(typeof (back.events[0] as ForkBootEvent).blockNumber).toBe("bigint");
  });

  test("merging keeps event order and unions labels and tokens", () => {
    const a: RunLog = { events: [boot], labels: { [alice]: "alice" }, tokens: {} };
    const b: RunLog = {
      events: [arbBoot],
      labels: { [bob]: "bob" },
      tokens: { x: { decimals: 6 } },
    };
    expect(mergeRunLogs([a, b])).toEqual({
      events: [boot, arbBoot],
      labels: { [alice]: "alice", [bob]: "bob" },
      tokens: { x: { decimals: 6 } },
    });
  });
});

describe("token metadata", () => {
  test("options.tokens name and scale tokens the run log could not read", () => {
    const bare: RunLog = { ...run, tokens: {} };
    const text = formatRun(bare, {
      color: false,
      tokens: { [usdc.toUpperCase().replace("0X", "0x")]: { symbol: "USDC", decimals: 6 } },
    });
    expect(text).toMatch(/balance change +USDC +ETH/);
    expect(text).toMatch(/bob +\+250\.5\n/);
    // Arbitrum's USDC is a different address: still raw.
    expect(text).toContain("settled 99,500,000");
  });

  test("bridge relayers and solvers get a name when they have no label", () => {
    const text = formatRun({ ...run, labels: {} }, { color: false });
    expect(text).toMatch(/across relayer +-99\.5/);
  });

  test("collectRun skips token reads on forks whose cache is offline", async () => {
    const collector = collectRun();
    try {
      const offline = "http://127.0.0.1:9";
      emitForkitEvent({
        ...boot,
        rpcUrl: offline,
        cache: { ...(boot.cache as NonNullable<ForkBootEvent["cache"]>), mode: "offline" },
      });
      emitForkitEvent({ ...swapMined, rpcUrl: offline });
      emitForkitEvent({ ...fillMined, rpcUrl: "http://127.0.0.1:10" });
      const log = await collector.snapshot();
      expect(Object.keys(log.tokens)).toEqual([`42161:${arbUsdc}`]);
      expect(log.tokens[`42161:${arbUsdc}`]).toEqual({}); // nothing answers there
    } finally {
      collector.stop();
    }
  });
});

describe("vitest reporter", () => {
  const fakeTest = (state: "passed" | "failed", error?: object) =>
    ({
      name: "a plain test",
      parent: { type: "suite", fullName: "swap > plain" },
      module: { relativeModuleId: "test/swap.vitest.ts" },
      result: () => ({ state, errors: error === undefined ? [] : [error] }),
      diagnostic: () => ({ duration: 12 }),
    }) as unknown as Parameters<typeof testEvents>[0];

  test("brackets a plain test's events with test:start/test:end from vitest's result", () => {
    const events = testEvents(
      fakeTest("failed", { message: "expected 1 to be 2", actual: "1", expected: "2" }),
      [boot, swapSent, swapMined],
    );
    expect(events.map((e) => e.type)).toEqual([
      "fork:boot",
      "test:start",
      "tx:sent",
      "tx:mined",
      "test:end",
    ]);
    expect(events.at(-1)).toMatchObject({
      suite: "swap > plain",
      name: "a plain test",
      status: "fail",
      durationMs: 12,
      error: "expected 1 to be 2",
      actual: "1",
      expected: "2",
    });
  });

  test("keeps itFork's own test events, filling in vitest's actual/expected", () => {
    const own = [start(9, "own"), end(9, "own", { status: "fail", error: "boom" })];
    const events = testEvents(fakeTest("failed", { message: "boom", actual: 1, expected: 2 }), own);
    expect(events.at(-1)).toMatchObject({ testId: 9, actual: "1", expected: "2" });
  });

  test("the reporter prints each file's run log from task meta", () => {
    const written: string[] = [];
    const meta = (log: RunLog) => ({ [META_KEY]: serializeRunLog(log) });
    const test1 = {
      ...fakeTest("passed"),
      meta: () => meta({ ...run, events: run.events.slice(0, 7) }),
    };
    const module = {
      relativeModuleId: "test/swap.vitest.ts",
      children: { allTests: () => [test1] },
      meta: () => ({}),
    } as unknown as Parameters<ForkitReporter["onTestRunEnd"]>[0][number];
    new ForkitReporter({ color: false, write: (t) => written.push(t) }).onTestRunEnd([module]);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("forkit · test/swap.vitest.ts");
    expect(written[0]).toContain("✓ swap › swaps ETH for USDC and pays bob");
    expect(written[0]).toMatch(/bob +\+250\.5/);
  });
});
