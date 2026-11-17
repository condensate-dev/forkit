/** The fill journal's file names and JSON values. The files themselves: test/anvil/bridges-long-running.vitest.ts. */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fillJournalFile } from "../../src/bridges/index.ts";
import { toJsonValue } from "../../src/bridges/journal.ts";

describe("the fill journal's file names and values", () => {
  test("a file is named from the bridge and the key, with unsafe characters replaced", () => {
    expect(fillJournalFile("/j", "across", "8453-17")).toBe(join("/j", "across-8453-17.json"));
    expect(fillJournalFile("/j", "toy", "31337:0xabc:2")).toBe(
      join("/j", "toy-31337-0xabc-2.json"),
    );
    expect(fillJournalFile("/j", "my bridge", "../x")).toBe(join("/j", "my-bridge-..-x.json"));
  });

  test("bigints become decimal strings, undefined is dropped", () => {
    expect(
      toJsonValue({ amount: 2n ** 80n, list: [1n, "a", null, true], none: undefined, n: 1.5 }),
    ).toEqual({ amount: "1208925819614629174706176", list: ["1", "a", null, true], n: 1.5 });
  });
});
