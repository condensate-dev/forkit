import { afterAll, describe, expect } from "bun:test";
import * as bunAdapter from "../../src/svm/bun.ts";
import { adapterContract } from "./adapter-contract.ts";
import { startUpstream } from "./upstream.ts";

const upstream = await startUpstream();
afterAll(() => upstream.stop());

adapterContract("bun:test", bunAdapter, upstream.rpcUrl, describe, {
  equal: (actual, expected) => expect(actual).toEqual(expected),
});
