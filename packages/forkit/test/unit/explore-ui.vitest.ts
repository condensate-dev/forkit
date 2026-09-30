/**
 * The explorer UI's pure parts (src/explore/ui/lib): routes, the timeline, call-tree rows, the gas
 * icicle, token flows, bridge fees, search, expected-vs-actual diffs and reproduction snippets,
 * over the showcase run; and the stylesheet's colour tokens, checked for WCAG AA contrast.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { RunRecord, TraceFrame } from "../../src/explore/schema.ts";
import { compact, formatSeconds, formatUnits } from "../../src/explore/ui/lib/format.js";
import {
  balanceSeries,
  bridgeFee,
  defaultOpen,
  diffLines,
  diffStrings,
  icicle,
  indexRun,
  parseHash,
  revertOrigin,
  route,
  search,
  snippets,
  timeline,
  tokenTransfers,
  traceRows,
} from "../../src/explore/ui/lib/model.js";

const run = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../fixtures/explore/showcase.json"), "utf8"),
) as RunRecord;
const idx = indexRun(run);
const testNamed = (prefix: string) => {
  const found = run.tests.find((t) => t.name.startsWith(prefix));
  if (found === undefined) throw new Error(`no test ${prefix}`);
  return found;
};
const txCalled = (name: string, status = "success") => {
  const found = run.txs.find((t) => t.call?.name === name && t.status === status);
  if (found === undefined) throw new Error(`no ${status} ${name}`);
  return found;
};

describe("routes", () => {
  test("every view and selection round-trips through the URL hash", () => {
    const hash = route(["run", "a b", "tx", "w:1"], { frame: "0.1", empty: "" });
    expect(hash).toBe("#/run/a%20b/tx/w%3A1?frame=0.1");
    const { parts, params } = parseHash(hash);
    expect(parts).toEqual(["run", "a b", "tx", "w:1"]);
    expect(params.get("frame")).toBe("0.1");
    expect(parseHash("#/").parts).toEqual([]);
  });
});

describe("timeline", () => {
  test("a test's cheats and transactions in order, each transaction under its prank", () => {
    const swap = testNamed("swaps");
    const steps = timeline(idx, swap.key).map(
      (i: { kind: string; value: { cheat?: string; call?: { name: string } }; as?: string }) => [
        i.kind,
        i.value.cheat ?? i.value.call?.name ?? "",
        i.as ?? "",
      ],
    );
    const alice = Object.entries(run.labels).find(([, n]) => n === "alice")?.[0];
    expect(steps).toEqual([
      ["deal", "", ""],
      ["deal", "", ""],
      ["cheat", "warp", ""],
      ["cheat", "prank", ""],
      ["tx", "approve", alice],
      ["tx", "exactInputSingle", alice],
      ["gas", "", ""],
      ["cheat", "stopPrank", ""],
    ]);
  });

  test("a failed test ends with its assertion", () => {
    const failed = testNamed("fails on purpose");
    const items = timeline(idx, failed.key);
    expect(items.at(-1)).toMatchObject({ kind: "assert", value: { expected: "1000000000" } });
  });
});

describe("call trees", () => {
  const frame = (over: Partial<TraceFrame>): TraceFrame => ({
    type: "CALL",
    from: "0x01",
    input: "0x",
    ...over,
  });

  test("rows interleave a frame's events with its subcalls at their position", () => {
    const trace = frame({
      gasUsed: "100",
      calls: [frame({ gasUsed: "40" }), frame({ gasUsed: "20" })],
      logs: [
        { address: "0xa", topics: [], data: "0x", position: 0 },
        { address: "0xb", topics: [], data: "0x", position: 1 },
        { address: "0xc", topics: [], data: "0x", position: 2 },
      ],
    });
    const rows = traceRows(trace, new Set(["0"])).map(
      (r: { type: string; path: string; depth: number }) => `${r.type}:${r.path}:${r.depth}`,
    );
    expect(rows).toEqual([
      "frame:0:0",
      "log:0#0:1",
      "frame:0.0:1",
      "log:0#1:1",
      "frame:0.1:1",
      "log:0#2:1",
    ]);
    // Collapsed: just the frame.
    expect(traceRows(trace, new Set())).toHaveLength(1);
  });

  test("the icicle lays children inside their caller, as wide as their gas", () => {
    const trace = frame({
      gasUsed: "100",
      calls: [
        frame({ gasUsed: "50", calls: [frame({ gasUsed: "25" })] }),
        frame({ gasUsed: "30" }),
      ],
    });
    const { cells, depth } = icicle(trace);
    const at = (path: string) => cells.find((c: { path: string }) => c.path === path);
    expect(depth).toBe(3);
    expect(at("0")).toMatchObject({ x0: 0, x1: 1, depth: 0 });
    expect(at("0.0")).toMatchObject({ x0: 0, x1: 0.5 });
    expect(at("0.1")).toMatchObject({ x0: 0.5, x1: 0.8 });
    expect(at("0.0.0")).toMatchObject({ x0: 0, x1: 0.25, depth: 2 });
  });

  test("a revert opens the way to where it started, and that frame is found", () => {
    const reverted = txCalled("deposit", "reverted");
    const origin = revertOrigin(reverted.trace);
    expect(origin?.path).toBe("0.0.0.0");
    expect(origin?.frame.revert).toContain("transfer amount exceeds balance");
    const open = defaultOpen(reverted.trace, 1);
    expect([...open].sort()).toEqual(["0", "0.0", "0.0.0"]);
  });
});

describe("value moved", () => {
  test("token transfers come from Transfer events, ether from the trace", () => {
    const swap = txCalled("exactInputSingle");
    const moved = tokenTransfers(swap);
    expect(moved.map((t: { token: string }) => t.token)).toEqual([
      "0x4200000000000000000000000000000000000006",
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    ]);
    expect(moved[1]).toMatchObject({ amount: "1000000000" });
  });

  test("a bridge fill's fee: what the deposit locked minus what the fill paid", () => {
    const [linked] = idx.fills;
    expect(bridgeFee(linked)).toEqual({
      input: "1000000000",
      output: "999890778",
      fee: "109222",
      inputToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      outputToken: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    });
    expect(linked.deposit?.call?.name).toBe("deposit");
    expect(linked.fillTxs[0]?.tx?.call?.name).toBe("fillRelay");
  });

  test("an address's balance over the run: deals set it, transactions move it", () => {
    const alice = Object.entries(run.labels).find(([, n]) => n === "alice")?.[0] as string;
    const usdc = balanceSeries(idx, alice).find(
      (s: { token: string }) => s.token === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    );
    expect(
      usdc.points.map((p: { deal?: unknown; value?: string }) => [p.deal ? "deal" : "tx", p.value]),
    ).toEqual([
      ["deal", "1000000000"],
      ["tx", "0"],
      ["deal", "10000000"],
      ["deal", "1000000000"],
      ["tx", "0"],
    ]);
  });
});

describe("search", () => {
  test("finds labels, tests, functions and hashes; exact and prefix matches first", () => {
    expect(search(idx, "alice")[0]).toMatchObject({ kind: "address", text: "alice" });
    expect(search(idx, "swaps")[0]).toMatchObject({ kind: "test" });
    expect(search(idx, "fillRelay")[0]).toMatchObject({ kind: "tx", text: "fillRelay" });
    const deposit = txCalled("deposit");
    expect(search(idx, deposit.hash?.slice(0, 10) as string)[0]).toMatchObject({
      kind: "tx",
      id: deposit.id,
    });
    expect(search(idx, "USDC")[0]).toMatchObject({ kind: "address" });
    const unknown = `0x${"12".repeat(20)}`;
    expect(search(idx, unknown)).toEqual([expect.objectContaining({ address: unknown })]);
    expect(search(idx, "   ")).toEqual([]);
  });
});

describe("expected vs actual", () => {
  test("marks the characters that differ", () => {
    expect(diffStrings("balance 1000", "balance 1300")).toEqual({
      expected: { same0: "balance 1", diff: "0", same1: "00" },
      actual: { same0: "balance 1", diff: "3", same1: "00" },
    });
  });

  test("diffs multi-line values line by line", () => {
    expect(diffLines("{\n  a: 1,\n  b: 2\n}", "{\n  a: 1,\n  b: 3\n}")).toEqual([
      { op: " ", text: "{" },
      { op: " ", text: "  a: 1," },
      { op: "-", text: "  b: 2" },
      { op: "+", text: "  b: 3" },
      { op: " ", text: "}" },
    ]);
  });
});

describe("copy as code", () => {
  test("the forkit snippet replays the test's steps on the chain up to the transaction", () => {
    const deposit = txCalled("deposit");
    const { forkit, viem } = snippets(idx, deposit);
    expect(forkit).toContain('import { base } from "viem/chains";');
    expect(forkit).toContain("blockNumber: 51907866n");
    expect(forkit).toContain("await f.dealNative(");
    expect(forkit).toContain('await f.deal("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"');
    // approve, then the deposit itself, each as its sender; nothing after it, nothing on Arbitrum.
    expect(forkit.match(/await f\.prank\(/g)).toHaveLength(2);
    expect(forkit).toContain("// deposit(bytes32,");
    expect(forkit).not.toContain("fillRelay");
    // Balanced brackets: the snippet parses.
    for (const [open, close] of [
      ["(", ")"],
      ["{", "}"],
    ] as const) {
      expect(forkit.split(open).length).toBe(forkit.split(close).length);
    }
    expect(viem).toContain(`await client.impersonateAccount({ address: "${deposit.from}" });`);
    expect(viem).toContain(`to: "${deposit.to}",`);
    expect(viem).toContain("--fork-block-number 51907866");
  });

  test("reproducing a revert sends it plainly, after the steps before it", () => {
    const test = testNamed("a deposit above");
    const approve = run.txs.find((t) => t.test === test.key && t.call?.name === "approve");
    const reverted = run.txs.find((t) => t.test === test.key && t.status === "reverted");
    expect(approve && reverted).toBeTruthy();
    // Reproducing the revert itself sends it (plainly), after the approve.
    const { forkit } = snippets(idx, reverted);
    expect(forkit).not.toContain("expectRevert");
    expect(forkit.match(/await f\.prank\(/g)).toHaveLength(2);
  });
});

describe("formatting", () => {
  test("units, compact numbers and durations", () => {
    expect(formatUnits("999890778", 6)).toBe("999.890778");
    expect(formatUnits("-1", 18)).toBe("-<0.000001");
    expect(compact(68_804)).toBe("68.8K");
    expect(compact(129_311)).toBe("129K");
    expect(compact(1_234)).toBe("1,234");
    expect(formatSeconds(60)).toBe("1 min");
    expect(formatSeconds(90_061)).toBe("1 d 1 h");
  });
});

describe("the stylesheet", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../../src/explore/ui/app.css"), "utf8");
  const tokens = new Map<string, [string, string]>();
  for (const m of css.matchAll(
    /--([a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi,
  )) {
    tokens.set(m[1] as string, [m[2] as string, m[3] as string]);
  }
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  test("every text colour meets WCAG AA (4.5:1) on every surface it sits on, light and dark", () => {
    const texts = ["ink", "muted", "faint", "accent", "ok", "bad"];
    const surfaces = ["bg", "surface", "surface-2", "accent-soft"];
    const pairs = [
      ...texts.flatMap((t) => surfaces.map((s) => [t, s])),
      ["ok", "ok-bg"],
      ["bad", "bad-bg"],
      ["warn", "warn-bg"],
      ["ink", "bad-bg"],
      ["muted", "bad-bg"],
      ["ink", "ok-bg"],
      ["ink", "ice"],
      ["accent", "ice"],
      ["accent-ink", "accent"],
    ];
    const failures: string[] = [];
    for (const [text, surface] of pairs) {
      const t = tokens.get(text as string);
      const s = tokens.get(surface as string);
      expect(t, text).toBeDefined();
      expect(s, surface).toBeDefined();
      ["light", "dark"].forEach((scheme, i) => {
        const ratio = contrast(
          (t as [string, string])[i] as string,
          (s as [string, string])[i] as string,
        );
        if (ratio < 4.5) failures.push(`${scheme}: ${text} on ${surface} is ${ratio.toFixed(2)}:1`);
      });
    }
    expect(failures).toEqual([]);
  });

  test("the seam violet accent is Condensate's (#5a2ee6 light, #a394ff dark)", () => {
    expect(tokens.get("accent")).toEqual(["#5a2ee6", "#a394ff"]);
  });

  test("nothing is loaded from the network: no url() and no @import", () => {
    expect(css).not.toMatch(/url\(|@import/);
  });
});
