import { afterAll, describe, expect } from "@jest/globals";
import * as jestAdapter from "../../src/jest.ts";
import { adapterContract, startUpstreams } from "./adapter-contract.ts";

const upstreams = await startUpstreams();
afterAll(() => upstreams.stop());

adapterContract("jest", jestAdapter, upstreams, describe, {
  equal: (actual, expected) => expect(actual).toEqual(expected),
});
