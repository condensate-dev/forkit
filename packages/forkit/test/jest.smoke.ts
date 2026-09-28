import { describe, expect, test } from "@jest/globals";
import * as forkit from "../src/index.ts";
import { PUBLIC_FUNCTIONS } from "./public-api.ts";

const exported: Record<string, unknown> = { ...forkit };

describe("public API (jest)", () => {
  for (const name of PUBLIC_FUNCTIONS) {
    test(`exports ${name}`, () => {
      expect(typeof exported[name]).toBe("function");
    });
  }

  test("expectRevert fails on a call that succeeds", async () => {
    await expect(forkit.expectRevert(Promise.resolve(), "x")).rejects.toBeInstanceOf(
      forkit.ForkitAssertionError,
    );
  });
});
