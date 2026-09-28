import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as forkit from "../src/index.ts";
import { PUBLIC_FUNCTIONS } from "./public-api.ts";

const exported: Record<string, unknown> = { ...forkit };

describe("public API (node:test)", () => {
  for (const name of PUBLIC_FUNCTIONS) {
    test(`exports ${name}`, () => {
      assert.equal(typeof exported[name], "function");
    });
  }

  test("expectRevert fails on a call that succeeds", async () => {
    await assert.rejects(forkit.expectRevert(Promise.resolve(), "x"), forkit.ForkitAssertionError);
  });
});
