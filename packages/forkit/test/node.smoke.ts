import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as forkit from "../src/index.ts";
import { PUBLIC_FUNCTIONS, STUB_CALLS } from "./public-api.ts";

const exported: Record<string, unknown> = { ...forkit };

describe("public API (node:test)", () => {
  for (const name of PUBLIC_FUNCTIONS) {
    test(`exports ${name}`, () => {
      assert.equal(typeof exported[name], "function");
    });
  }

  for (const [name, call] of Object.entries(STUB_CALLS)) {
    test(`stub ${name} throws NotImplementedError`, async () => {
      await assert.rejects(call(), forkit.NotImplementedError);
    });
  }
});
