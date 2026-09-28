import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  formatGasSnapshot,
  parseGasSnapshot,
  recordGas,
  resolveGasSettings,
} from "../../src/gas.ts";
import { ForkitAssertionError } from "../../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "forkit-gas-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(dir, `snap-${n++}`);

describe("snapshot file format", () => {
  test("round-trips, sorted by label, ignoring junk lines", () => {
    const entries = parseGasSnapshot("b swap (gas: 20)\njunk\na deposit (gas: 10)\n");
    expect([...entries]).toEqual([
      ["b swap", 20n],
      ["a deposit", 10n],
    ]);
    expect(formatGasSnapshot(entries)).toBe("a deposit (gas: 10)\nb swap (gas: 20)\n");
  });
});

describe("resolveGasSettings", () => {
  test("write locally, check in CI, env and option override", () => {
    expect(resolveGasSettings(undefined, "/x", {}).mode).toBe("write");
    expect(resolveGasSettings(undefined, "/x", { CI: "true" }).mode).toBe("check");
    expect(resolveGasSettings(undefined, "/x", { CI: "false" }).mode).toBe("write");
    expect(
      resolveGasSettings(undefined, "/x", { CI: "1", FORKIT_GAS_SNAPSHOT: "write" }).mode,
    ).toBe("write");
    expect(resolveGasSettings("off", "/x", { FORKIT_GAS_SNAPSHOT: "check" }).mode).toBe("off");
    expect(resolveGasSettings(undefined, undefined, { FORKIT_GAS_SNAPSHOT_FILE: "/g" }).file).toBe(
      "/g",
    );
    expect(() => resolveGasSettings(undefined, "/x", { FORKIT_GAS_SNAPSHOT: "maybe" })).toThrow(
      /not one of/,
    );
    expect(() => resolveGasSettings("maybe" as "off", "/x", {})).toThrow(
      /gasSnapshot "maybe" is not one of/,
    );
  });
});

describe("recordGas", () => {
  test("write records and updates; check passes on equal, fails on change or missing", async () => {
    const file = fresh();
    await recordGas({ mode: "write", file }, "deposit", 100n);
    await recordGas({ mode: "write", file }, "withdraw", 50n);
    await recordGas({ mode: "write", file }, "deposit", 110n);
    expect(readFileSync(file, "utf8")).toBe("deposit (gas: 110)\nwithdraw (gas: 50)\n");

    await recordGas({ mode: "check", file }, "deposit", 110n);
    const changed = await recordGas({ mode: "check", file }, "deposit", 121n).catch((e) => e);
    expect(changed).toBeInstanceOf(ForkitAssertionError);
    expect(changed.message).toContain('gas for "deposit" changed: 110 → 121, +11 (+10.00%)');
    expect(changed).toMatchObject({ actual: 121n, expected: 110n });
    await expect(recordGas({ mode: "check", file }, "swap", 1n)).rejects.toThrow(
      /no gas snapshot for "swap".*FORKIT_GAS_SNAPSHOT=write/,
    );
    expect(readFileSync(file, "utf8")).toBe("deposit (gas: 110)\nwithdraw (gas: 50)\n");
  });

  test("off touches nothing; bad labels are refused", async () => {
    const file = fresh();
    await recordGas({ mode: "off", file }, "x", 1n);
    expect(() => readFileSync(file)).toThrow();
    await expect(recordGas({ mode: "write", file }, "two\nlines", 1n)).rejects.toThrow(
      /one non-empty line/,
    );
    await expect(recordGas({ mode: "write", file }, " padded", 1n)).rejects.toThrow(
      /one non-empty line/,
    );
  });

  test("parallel writers do not lose each other's entries", async () => {
    const file = fresh();
    writeFileSync(file, "existing (gas: 1)\n");
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        recordGas({ mode: "write", file }, `tx ${i}`, BigInt(i)),
      ),
    );
    const entries = parseGasSnapshot(readFileSync(file, "utf8"));
    expect(entries.size).toBe(26);
    expect(entries.get("tx 24")).toBe(24n);
  });
});
