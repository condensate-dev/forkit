/**
 * The contract every forkit/svm runner adapter keeps, run by each runner's own test file.
 */
import { redactUrl } from "../../src/rpc.ts";
import type { SurfnetAdapter } from "../../src/svm/index.ts";
import { SEEDED, SEEDED_LAMPORTS } from "./upstream.ts";

type Describe = (name: string, body: () => void) => void;
interface Expect {
  equal(actual: unknown, expected: unknown): void;
}

export function adapterContract(
  runner: string,
  adapter: SurfnetAdapter,
  upstreamUrl: string,
  describe: Describe,
  expect: Expect,
): void {
  const { describeSurfnet, itSurfnet } = adapter;
  let firstUrl: string | undefined;

  describeSurfnet(`${runner}: describeSurfnet`, { rpcUrl: upstreamUrl }, (s) => {
    let collectError: unknown;
    try {
      void s.rpcUrl;
    } catch (error) {
      collectError = error;
    }
    itSurfnet("the handle refuses use while tests are being collected", () => {
      expect.equal(collectError instanceof Error && /not running/.test(collectError.message), true);
    });

    itSurfnet("hands the test a ready surfnet forked from the source", async (t) => {
      expect.equal(t.rpcUrl, s.rpcUrl);
      expect.equal(t.source, redactUrl(upstreamUrl));
      expect.equal((await t.rpc.getBalance(SEEDED).send()).value, SEEDED_LAMPORTS);
      firstUrl = t.rpcUrl;
    });

    itSurfnet("keeps one surfnet for the whole suite", async (t) => {
      expect.equal(t.rpcUrl, firstUrl);
      expect.equal(await t.rpc.getHealth().send(), "ok");
    });

    describe("nested describe", () => {
      itSurfnet("still gets the enclosing surfnet", (t) => {
        expect.equal(t.rpcUrl, firstUrl);
      });
    });

    describeSurfnet("an inner describeSurfnet", { offline: true }, (inner) => {
      itSurfnet("gets its own surfnet, the nearest one", (t) => {
        expect.equal(t.rpcUrl, inner.rpcUrl);
        expect.equal(t.source, "offline");
        expect.equal(t.rpcUrl === firstUrl, false);
      });
    });
  });

  describeSurfnet(`${runner}: a second suite`, { rpcUrl: upstreamUrl }, () => {
    itSurfnet("boots its own surfnet", (t) => {
      expect.equal(t.rpcUrl === firstUrl, false);
    });
  });
}
