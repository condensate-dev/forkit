// Run by ../reporter.vitest.ts with `node --test`: the jest / node:test recipe, collectRun() in
// the file and formatRun() once its tests are done.
import { after, before } from "node:test";
import * as adapter from "../../../src/node.ts";
import { collectRun, formatRun } from "../../../src/reporter/index.ts";
import { startUpstream } from "../upstream.ts";
import { scenario } from "./scenario.ts";

const run = collectRun();
const upstream = await startUpstream();
scenario(adapter, upstream.url, before);
after(async () => {
  console.log(formatRun(await run.snapshot(), { title: "node:test" }));
  await upstream.stop();
});
