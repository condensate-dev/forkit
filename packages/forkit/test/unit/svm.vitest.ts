import { describe, expect, test } from "vitest";
import {
  assertSurfpoolInstalled,
  DEFAULT_SVM_RPC_URL,
  ForkitError,
  parseSurfpoolVersion,
  resolveSurfnetSource,
  resolveSurfpoolBinary,
  SURFPOOL_VERSION,
  SurfpoolNotFoundError,
  surfpoolArgs,
} from "../../src/svm/index.ts";

describe("resolveSurfnetSource", () => {
  test("explicit rpcUrl wins over the env", () => {
    expect(
      resolveSurfnetSource({ rpcUrl: "http://explicit" }, { FORKIT_SVM_RPC_URL: "http://env" }),
    ).toBe("http://explicit");
  });
  test("then FORKIT_SVM_RPC_URL, then public mainnet-beta", () => {
    expect(resolveSurfnetSource({}, { FORKIT_SVM_RPC_URL: "http://env" })).toBe("http://env");
    expect(resolveSurfnetSource({}, {})).toBe(DEFAULT_SVM_RPC_URL);
  });
  test("offline has no source, and refuses an rpcUrl too", () => {
    expect(resolveSurfnetSource({ offline: true }, { FORKIT_SVM_RPC_URL: "http://env" })).toBe(
      undefined,
    );
    expect(() => resolveSurfnetSource({ offline: true, rpcUrl: "http://x" })).toThrow(ForkitError);
  });
});

describe("resolveSurfpoolBinary", () => {
  test("option, then FORKIT_SURFPOOL_BIN, then PATH", () => {
    expect(resolveSurfpoolBinary("/opt/sp", { FORKIT_SURFPOOL_BIN: "/env/sp" })).toBe("/opt/sp");
    expect(resolveSurfpoolBinary(undefined, { FORKIT_SURFPOOL_BIN: "/env/sp" })).toBe("/env/sp");
    expect(resolveSurfpoolBinary(undefined, {})).toBe("surfpool");
  });
});

describe("parseSurfpoolVersion", () => {
  test("reads `surfpool --version`", () => {
    expect(parseSurfpoolVersion("surfpool 1.6.1")).toEqual([1, 6, 1]);
    expect(parseSurfpoolVersion("surfpool")).toBe(undefined);
  });
  test("the pin parses", () => {
    expect(parseSurfpoolVersion(SURFPOOL_VERSION)).toBeDefined();
  });
});

describe("assertSurfpoolInstalled", () => {
  test("a missing binary is a SurfpoolNotFoundError with an install hint", () => {
    const error = (() => {
      try {
        assertSurfpoolInstalled("/nonexistent/forkit-test/surfpool");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(SurfpoolNotFoundError);
    expect((error as Error).message).toContain("FORKIT_SURFPOOL_BIN");
    expect((error as Error).message).toContain("not a skipped test");
  });
});

describe("surfpoolArgs", () => {
  const ports = { rpc: 1001, ws: 1002, studio: 1003 };
  test("headless, no studio, no deploys, every listener on the given ports", () => {
    const args = surfpoolArgs({}, ports, "/tmp/logs", false);
    expect(args.slice(0, 4)).toEqual(["start", "--no-tui", "--no-studio", "--no-deploy"]);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag("--host")).toBe("127.0.0.1");
    expect(flag("--port")).toBe("1001");
    expect(flag("--ws-port")).toBe("1002");
    expect(flag("--studio-port")).toBe("1003");
    expect(flag("--log-path")).toBe("/tmp/logs");
    expect(args).not.toContain("--offline");
  });
  test("the fork URL never goes on the command line", () => {
    const args = surfpoolArgs({ rpcUrl: "https://rpc.example/secret-key" }, ports, "/l", false);
    expect(args.join(" ")).not.toContain("secret-key");
    expect(args).not.toContain("--rpc-url");
  });
  test("offline, slot time and extra flags", () => {
    const args = surfpoolArgs(
      { slotTimeMs: 50, args: ["--log-level", "debug"] },
      ports,
      "/l",
      true,
    );
    expect(args).toContain("--offline");
    expect(args[args.indexOf("--slot-time") + 1]).toBe("50");
    expect(args.slice(-2)).toEqual(["--log-level", "debug"]);
  });
});
