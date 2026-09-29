// Run by ../reporter.vitest.ts as `bun test --preload ./src/reporter/bun.ts <this file>`.
import { afterAll, beforeAll } from "bun:test";
import * as adapter from "../../../src/bun.ts";
import { startUpstream } from "../upstream.ts";
import { scenario } from "./scenario.ts";

const upstream = await startUpstream();
afterAll(() => upstream.stop());
scenario(adapter, upstream.url, beforeAll);
