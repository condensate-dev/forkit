import assert from "node:assert/strict";
import { after, describe } from "node:test";
import * as nodeAdapter from "../../src/node.ts";
import { adapterContract, startUpstreams } from "./adapter-contract.ts";

const upstreams = await startUpstreams();
after(() => upstreams.stop());

adapterContract(
  "node:test",
  nodeAdapter,
  upstreams,
  (name, body) => {
    describe(name, body);
  },
  {
    equal: (actual, expected) => assert.deepEqual(actual, expected),
  },
);
