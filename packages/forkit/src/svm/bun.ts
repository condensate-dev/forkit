/**
 * bun:test adapter for forkit/svm: `describeSurfnet` boots one surfnet per suite and stops it
 * after the last test; `itSurfnet` hands each test that surfnet.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "bun:test";
import { createSurfnetAdapter } from "./adapter.ts";

export type { Surfnet, SurfnetOptions } from "./surfnet.ts";

export const { describeSurfnet, itSurfnet } = createSurfnetAdapter({
  describe: (name, body) => describe(name, body),
  it: (name, fn, timeoutMs) => it(name, fn, timeoutMs),
  hooks: { beforeAll, afterAll, beforeEach, afterEach },
});
