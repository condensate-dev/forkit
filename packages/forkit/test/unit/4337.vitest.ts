import { createServer } from "node:http";
import { arbitrum, base, mainnet } from "viem/chains";
import { describe, expect, test } from "vitest";
import { resolveAlto } from "../../src/4337/alto.ts";
import {
  AltoNotFoundError,
  altoChainType,
  containsSend,
  DEFAULT_EXECUTOR_KEY,
  DEFAULT_UTILITY_KEY,
  ENTRY_POINTS,
  highestBlockIn,
  renderAltoFlags,
  resolveEntryPoints,
} from "../../src/4337/index.ts";
import { startRpcProxy } from "../../src/4337/proxy.ts";
import { freePort } from "../../src/index.ts";

describe("renderAltoFlags", () => {
  test("kebab-case flags, lists joined by commas, undefined dropped", () => {
    expect(
      renderAltoFlags({
        entrypoints: ["0xa", "0xb"],
        "safe-mode": false,
        port: 3000,
        "log-level": undefined,
      }),
    ).toEqual(["--entrypoints", "0xa,0xb", "--safe-mode", "false", "--port", "3000"]);
  });

  test("refuses a flag written with dashes or in camelCase", () => {
    expect(() => renderAltoFlags({ "--rpc-url": "x" })).toThrow(/not a kebab-case flag name/);
    expect(() => renderAltoFlags({ rpcUrl: "x" })).toThrow(/not a kebab-case flag name/);
  });
});

describe("resolveEntryPoints", () => {
  test("defaults to every canonical EntryPoint, not explicit", () => {
    expect(resolveEntryPoints(undefined)).toEqual({
      addresses: Object.values(ENTRY_POINTS),
      explicit: false,
    });
  });

  test("takes versions and addresses, checksums and de-duplicates", () => {
    const { addresses, explicit } = resolveEntryPoints([
      "0.7",
      ENTRY_POINTS["0.7"].toLowerCase() as `0x${string}`,
      "0.6",
    ]);
    expect(addresses).toEqual([ENTRY_POINTS["0.7"], ENTRY_POINTS["0.6"]]);
    expect(explicit).toBe(true);
  });

  test("refuses an empty list and anything that is neither", () => {
    expect(() => resolveEntryPoints([])).toThrow(/entryPoints is empty/);
    expect(() => resolveEntryPoints(["0.5" as "0.6"])).toThrow(/neither an EntryPoint version/);
  });
});

describe("altoChainType", () => {
  test("op-stack for OP-stack chains, arbitrum for Arbitrum, else default", () => {
    expect(altoChainType(base)).toBe("op-stack");
    expect(altoChainType(arbitrum)).toBe("arbitrum");
    expect(altoChainType(mainnet)).toBe("default");
  });
});

describe("keys and alto resolution", () => {
  test("the default executor and utility keys are fixed and distinct", () => {
    expect(DEFAULT_EXECUTOR_KEY).toMatch(/^0x[0-9a-f]{64}$/);
    expect(DEFAULT_UTILITY_KEY).not.toBe(DEFAULT_EXECUTOR_KEY);
  });

  test("an explicit .js CLI runs on node; any other path runs directly", () => {
    expect(resolveAlto("/x/alto.js").args).toEqual(["/x/alto.js"]);
    expect(resolveAlto("/usr/local/bin/alto")).toEqual({
      command: "/usr/local/bin/alto",
      args: [],
    });
  });

  test("resolves the installed @pimlico/alto CLI", () => {
    const alto = resolveAlto();
    expect(alto.args[0]).toMatch(/@pimlico[/\\]alto[/\\]esm[/\\]cli[/\\]alto\.js$/);
  });

  test("AltoNotFoundError is a ForkitError with an install hint", () => {
    expect(new AltoNotFoundError("x").message).toMatch(/@pimlico\/alto/);
  });
});

describe("proxy helpers", () => {
  test("containsSend spots a user operation send, alone or in a batch", () => {
    expect(containsSend({ method: "eth_sendUserOperation" })).toBe(true);
    expect(
      containsSend([{ method: "eth_chainId" }, { method: "pimlico_sendUserOperationNow" }]),
    ).toBe(true);
    expect(containsSend({ method: "eth_estimateUserOperationGas" })).toBe(false);
    expect(containsSend(null)).toBe(false);
  });

  test("highestBlockIn reads block numbers from matching replies only", () => {
    const payload = [
      { id: 1, method: "eth_blockNumber" },
      { id: 2, method: "eth_getBlockByNumber" },
      { id: 3, method: "eth_getBalance" },
    ];
    const reply = [
      { id: 1, result: "0x10" },
      { id: 2, result: { number: "0x20" } },
      { id: 3, result: "0x99" },
    ];
    expect(highestBlockIn(payload, reply)).toBe(0x20n);
    expect(
      highestBlockIn({ id: 1, method: "eth_chainId" }, { id: 1, result: "0x1" }),
    ).toBeUndefined();
  });

  test("startRpcProxy forwards, lets hooks observe, and closes", async () => {
    const upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const { id } = JSON.parse(body) as { id: number };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x2a" }));
      });
    });
    await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", () => ok()));
    const { port } = upstream.address() as { port: number };
    const seen: unknown[] = [];
    const proxy = await startRpcProxy({
      upstream: `http://127.0.0.1:${port}`,
      port: await freePort(),
      async before(payload) {
        seen.push(["before", payload]);
      },
      async after(_payload, reply) {
        seen.push(["after", reply]);
      },
    });
    try {
      const response = await fetch(proxy.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_blockNumber" }),
      });
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: "0x2a" });
      expect(seen).toHaveLength(2);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });
});
