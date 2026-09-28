import { afterAll, describe, expect } from "bun:test";
import * as bunAdapter from "../../src/bun.ts";
import { adapterContract, startUpstreams } from "./adapter-contract.ts";

const upstreams = await startUpstreams();
afterAll(() => upstreams.stop());

adapterContract("bun:test", bunAdapter, upstreams, describe, {
  equal: (actual, expected) => expect(actual).toEqual(expected),
});
