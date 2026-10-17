import { afterAll, describe, expect } from "vitest";
import * as vitestAdapter from "../../src/svm/vitest.ts";
import { adapterContract } from "./adapter-contract.ts";
import { startUpstream } from "./upstream.ts";

const upstream = await startUpstream();
afterAll(() => upstream.stop());

adapterContract("vitest", vitestAdapter, upstream.rpcUrl, describe, {
  equal: (actual, expected) => expect(actual).toEqual(expected),
});
