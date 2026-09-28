import { describe, expect, test } from "@jest/globals";
import * as forkit from "../src/index.ts";
import { PUBLIC_FUNCTIONS, STUB_CALLS } from "./public-api.ts";

const exported: Record<string, unknown> = { ...forkit };

describe("public API (jest)", () => {
  for (const name of PUBLIC_FUNCTIONS) {
    test(`exports ${name}`, () => {
      expect(typeof exported[name]).toBe("function");
    });
  }

  for (const [name, call] of Object.entries(STUB_CALLS)) {
    test(`stub ${name} throws NotImplementedError`, async () => {
      await expect(call()).rejects.toBeInstanceOf(forkit.NotImplementedError);
    });
  }
});
