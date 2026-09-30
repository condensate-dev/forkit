import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Address,
  encodeAbiParameters,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  pad,
  toFunctionSelector,
} from "viem";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import type { RawRequest } from "../../src/client.ts";
import { type ForkitEvent, observersSettled } from "../../src/events.ts";
import { stringify, toJson } from "../../src/explore/json.ts";
import { balanceChanges, RunRecorder } from "../../src/explore/recorder.ts";
import type { RunRecord } from "../../src/explore/schema.ts";
import { startExploreServer } from "../../src/explore/server.ts";
import { SlotNamer, stateDiff } from "../../src/explore/state.ts";
import {
  listRuns,
  mergeRun,
  parsePart,
  readRun,
  recordingEnabled,
  resolveRunId,
  runFile,
  runnerPid,
} from "../../src/explore/store.ts";
import { clearLabels, label } from "../../src/index.ts";
import type { CallFrame } from "../../src/trace.ts";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "forkit-explore-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => clearLabels());

const alice: Address = "0x00000000000000000000000000000000000a11ce";
const bob: Address = "0x0000000000000000000000000000000000000b0b";
const token: Address = "0x1111111111111111111111111111111111111111";
const vault: Address = "0x2222222222222222222222222222222222222222";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const HASH = `0x${"ab".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"cd".repeat(32)}` as Hex;
/** Where Solidity keeps `mapping[key]` for a mapping declared at `slot`. */
const mappingSlot = (key: Hex, slot: Hex): Hex => keccak256(`${pad(key)}${pad(slot).slice(2)}`);
const word = (value: bigint): Hex => pad(numberToHex(value));
const transferData = (to: Address, amount: bigint): Hex =>
  `${toFunctionSelector("transfer(address,uint256)")}${encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [to, amount],
  ).slice(2)}`;

describe("toJson / stringify", () => {
  test("bigints become decimal strings, at any depth", () => {
    expect(toJson({ a: 1n, b: [2n, { c: -3n }], d: 10n ** 30n })).toEqual({
      a: "1",
      b: ["2", { c: "-3" }],
      d: "1000000000000000000000000000000",
    });
    expect(stringify({ gas: 21_000n })).toBe('{"gas":"21000"}');
  });

  test("drops undefined and functions, and handles bytes, dates, maps, NaN and cycles", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    expect(
      toJson({
        u: undefined,
        f: () => 1,
        bytes: new Uint8Array([1, 255]),
        at: new Date(5),
        map: new Map([[1, 2n]]),
        nan: Number.NaN,
        list: [undefined, 1],
        cyclic,
      }),
    ).toEqual({
      bytes: "0x01ff",
      at: 5,
      map: { "1": "2" },
      nan: null,
      list: [null, 1],
      cyclic: { name: "x", self: "[circular]" },
    });
  });
});

describe("balanceChanges", () => {
  test("native value in the trace (not in reverted frames), the gas fee, and ERC-20 transfers", () => {
    const trace: CallFrame = {
      type: "CALL",
      from: alice,
      to: vault,
      value: numberToHex(100n),
      input: "0x",
      calls: [
        { type: "CALL", from: vault, to: bob, value: numberToHex(40n), input: "0x" },
        {
          type: "CALL",
          from: vault,
          to: bob,
          value: numberToHex(7n),
          input: "0x",
          error: "execution reverted",
        },
        { type: "DELEGATECALL", from: vault, to: bob, value: numberToHex(9n), input: "0x" },
      ],
    };
    const logs = [
      { address: token, topics: [TRANSFER, pad(alice), pad(bob)], data: pad(numberToHex(5n)) },
      // Mint: the zero address is not a holder.
      { address: token, topics: [TRANSFER, pad("0x0"), pad(alice)], data: pad(numberToHex(2n)) },
      // ERC-721 Transfer (id indexed): not a balance.
      { address: token, topics: [TRANSFER, pad(alice), pad(bob), pad("0x1")], data: "0x" },
    ];
    const changes = balanceChanges(trace, logs, alice, 3n);
    const of = (who: string, t: string) =>
      changes.find((c) => c.address === who && c.token === t)?.delta;
    expect(of(alice, "native")).toBe("-103");
    expect(of(vault, "native")).toBe("60");
    expect(of(bob, "native")).toBe("40");
    expect(of(alice, token.toLowerCase())).toBe("-3");
    expect(of(bob, token.toLowerCase())).toBe("5");
    expect(changes).toHaveLength(5);
  });
});

/** A fork that answers the recorder's reads for one mined transaction. */
function fakeFork(): { request: RawRequest; calls: string[] } {
  const calls: string[] = [];
  const request: RawRequest = async ({ method, params }) => {
    calls.push(method);
    switch (method) {
      case "eth_getTransactionReceipt":
        return {
          status: "0x1",
          blockNumber: "0x10",
          blockHash: BLOCK_HASH,
          gasUsed: numberToHex(50_000n),
          effectiveGasPrice: numberToHex(2n),
          contractAddress: null,
          logs: [
            {
              address: token,
              topics: [TRANSFER, pad(alice), pad(bob)],
              data: pad(numberToHex(1_500_000n)),
              logIndex: "0x0",
            },
          ],
        };
      case "eth_getBlockByHash":
        return { timestamp: numberToHex(1_700_000_000n) };
      case "debug_traceTransaction": {
        const [, tracer] = params as [Hex, { tracer: string; tracerConfig?: object }];
        if (tracer.tracer === "prestateTracer") {
          // alice pays gas and 1.5 TKN from mapping(0); bob's balance slot is new.
          return {
            pre: {
              [alice]: { balance: numberToHex(100_999n), nonce: 4 },
              [token]: {
                balance: "0x0",
                nonce: 1,
                code: "0x6000",
                storage: { [mappingSlot(alice, "0x0")]: word(5_500_000n) },
              },
            },
            post: {
              [alice]: { balance: numberToHex(999n), nonce: 5 },
              [token]: {
                storage: {
                  [mappingSlot(alice, "0x0")]: word(4_000_000n),
                  [mappingSlot(bob, "0x0")]: word(1_500_000n),
                },
              },
            },
          };
        }
        return {
          type: "CALL",
          from: alice,
          to: token,
          input: transferData(bob, 1_500_000n),
          output: pad("0x1"),
          gasUsed: numberToHex(30_000n),
          ...(tracer.tracerConfig === undefined
            ? {}
            : {
                logs: [
                  {
                    address: token,
                    topics: [TRANSFER, pad(alice), pad(bob)],
                    data: pad(numberToHex(1_500_000n)),
                    position: "0x0",
                    index: "0x0",
                  },
                ],
              }),
        } satisfies CallFrame;
      }
      case "debug_traceCall":
        return {
          type: "CALL",
          from: alice,
          to: vault,
          input: "0xd0e30db0",
          output: `0x08c379a0${encodeAbiParameters([{ type: "string" }], ["Vault: zero deposit"]).slice(2)}`,
          error: "execution reverted",
          gasUsed: numberToHex(21_500n),
        } satisfies CallFrame;
      case "eth_getBalance":
        return numberToHex(999n);
      case "eth_call": {
        const [{ data }] = params as [{ data: Hex }];
        if (data.startsWith(toFunctionSelector("symbol()")))
          return encodeAbiParameters([{ type: "string" }], ["TKN"]);
        if (data.startsWith(toFunctionSelector("decimals()")))
          return encodeAbiParameters([{ type: "uint8" }], [6]);
        if (data.startsWith(toFunctionSelector("name()")))
          return encodeAbiParameters([{ type: "string" }], ["Token"]);
        return pad(numberToHex(4_000_000n));
      }
    }
    throw new Error(`unexpected ${method}`);
  };
  return { request, calls };
}

const RPC = "http://127.0.0.1:1";
/** One test's worth of run events. */
function events(testId: number, ts: number): ForkitEvent[] {
  return [
    {
      type: "fork:boot",
      ts,
      chainId: 1,
      chainName: "Ethereum",
      blockNumber: 100n,
      upstream: "https://rpc.example/***",
      rpcUrl: RPC,
      bootMs: 12,
      nativeSymbol: "ETH",
    },
    { type: "test:start", ts: ts + 1, testId, suite: "Vault", name: `moves tokens ${testId}` },
    { type: "deal", ts: ts + 2, chainId: 1, rpcUrl: RPC, token, holder: alice, amount: 5_000_000n },
    { type: "cheat", ts: ts + 2, chainId: 1, rpcUrl: RPC, cheat: "prank", account: alice },
    {
      type: "tx:sent",
      ts: ts + 3,
      chainId: 1,
      rpcUrl: RPC,
      hash: HASH,
      kind: "writeContract",
      from: alice,
      to: token,
      data: transferData(bob, 1_500_000n),
      functionName: "transfer",
    },
    {
      type: "tx:reverted",
      ts: ts + 4,
      chainId: 1,
      rpcUrl: RPC,
      kind: "sendTransaction",
      from: alice,
      to: vault,
      data: "0xd0e30db0",
      value: 0n,
      message: "reverted: Vault: zero deposit",
    },
    { type: "cheat", ts: ts + 4, chainId: 1, rpcUrl: RPC, cheat: "stopPrank", account: alice },
    {
      type: "cheat",
      ts: ts + 4,
      chainId: 1,
      rpcUrl: RPC,
      cheat: "warp",
      seconds: 86_400n,
      blockNumber: 17n,
      timestamp: 1_700_086_400n,
    },
    {
      type: "bridge:fill",
      ts: ts + 5,
      bridge: "across",
      depositId: `1:${HASH}:0`,
      originChainId: 1,
      destinationChainId: 10,
      depositTxHash: HASH,
      txHashes: [HASH],
      outputAmount: 1_499_000n,
      details: { fee: 1_000n },
    },
    {
      type: "http:request",
      ts: ts + 6,
      fixture: "quotes",
      method: "GET",
      url: "https://api.example/quote?key=***",
      outcome: "hit",
    },
    {
      type: "gas:snapshot",
      ts: ts + 7,
      label: "transfer",
      gas: 50_000n,
      mode: "check",
      file: ".gas-snapshot",
      previous: 49_000n,
    },
    {
      type: "test:end",
      ts: ts + 8,
      testId,
      suite: "Vault",
      name: `moves tokens ${testId}`,
      status: testId % 2 === 0 ? "fail" : "pass",
      durationMs: 7,
      ...(testId % 2 === 0 ? { error: "expected 1 to be 2", actual: "1", expected: "2" } : {}),
    },
  ];
}

describe("RunRecorder", () => {
  test("builds a run part from events, enriching transactions while the fork is up", async () => {
    label(alice, "alice");
    const fork = fakeFork();
    const recorder = new RunRecorder({ runId: "unit", write: false, request: () => fork.request });
    for (const event of events(1, 1_000)) recorder.handle(event);
    await observersSettled();
    const part = recorder.part;

    expect(part.forks).toEqual([
      expect.objectContaining({
        chainId: 1,
        chainName: "Ethereum",
        blockNumber: "100",
        nativeSymbol: "ETH",
      }),
    ]);
    const key = `${part.worker}:1`;
    expect(part.tests).toEqual([
      expect.objectContaining({
        key,
        suite: "Vault",
        name: "moves tokens 1",
        status: "pass",
        startedAt: 1_001,
        durationMs: 7,
      }),
    ]);
    expect(part.deals).toEqual([
      expect.objectContaining({
        test: key,
        token: token.toLowerCase(),
        holder: alice,
        amount: "5000000",
      }),
    ]);

    const [mined, reverted] = part.txs;
    expect(mined).toMatchObject({
      test: key,
      hash: HASH,
      mined: true,
      status: "success",
      blockNumber: "16",
      blockHash: BLOCK_HASH,
      blockTimestamp: 1_700_000_000,
      gasUsed: "50000",
      effectiveGasPrice: "2",
      call: { name: "transfer", signature: "transfer(address,uint256)" },
    });
    expect(mined?.call?.args).toEqual([
      { name: "recipient", type: "address", value: getAddress(bob) },
      { name: "amount", type: "uint256", value: "1500000" },
    ]);
    expect(mined?.logs[0]?.event).toMatchObject({ name: "Transfer" });
    expect(mined?.trace).toMatchObject({
      type: "CALL",
      call: { name: "transfer" },
      result: [{ type: "bool", value: true }],
    });
    expect(mined?.traceText).toContain("::transfer(");
    // The frame's own events, decoded, where they happened among its subcalls.
    expect(mined?.trace?.logs).toEqual([
      expect.objectContaining({
        address: token,
        position: 0,
        index: 0,
        event: expect.objectContaining({ name: "Transfer" }),
      }),
    ]);
    // What changed, account by account, with storage slots named after the labelled holder.
    expect(mined?.stateDiff).toEqual([
      {
        address: alice,
        balance: { before: "100999", after: "999" },
        nonce: { before: 4, after: 5 },
        storage: [],
      },
      {
        address: token,
        storage: expect.arrayContaining([
          {
            slot: mappingSlot(alice, "0x0"),
            before: word(5_500_000n),
            after: word(4_000_000n),
            hint: "mapping(0)[alice]",
          },
          {
            slot: mappingSlot(bob, "0x0"),
            before: word(0n),
            after: word(1_500_000n),
            hint: "mapping(0)[0x0000…0b0b]",
          },
        ]),
      },
    ]);
    expect(mined?.balanceChanges).toEqual(
      expect.arrayContaining([
        { address: alice, token: "native", delta: "-100000", after: "999" },
        { address: alice, token: token.toLowerCase(), delta: "-1500000", after: "4000000" },
        { address: bob, token: token.toLowerCase(), delta: "1500000", after: "4000000" },
      ]),
    );
    expect(reverted).toMatchObject({
      test: key,
      mined: false,
      status: "reverted",
      revert: 'Error("Vault: zero deposit")',
      error: "reverted: Vault: zero deposit",
      gasUsed: "21500",
    });
    expect(reverted?.hash).toBeUndefined();
    expect(reverted?.traceText).toContain("[Revert]");

    expect(part.fills).toEqual([
      expect.objectContaining({
        bridge: "across",
        outputAmount: "1499000",
        details: { fee: "1000" },
        txHashes: [HASH],
      }),
    ]);
    expect(part.http).toEqual([expect.objectContaining({ outcome: "hit", fixture: "quotes" })]);
    expect(part.cheats).toEqual([
      expect.objectContaining({ test: key, cheat: "prank", account: alice, ts: 1_002 }),
      expect.objectContaining({ test: key, cheat: "stopPrank", account: alice }),
      expect.objectContaining({
        test: key,
        cheat: "warp",
        seconds: "86400",
        blockNumber: "17",
        timestamp: "1700086400",
      }),
    ]);
    expect(part.gas).toEqual([
      expect.objectContaining({ label: "transfer", gas: "50000", previous: "49000" }),
    ]);
    expect(part.tokens[`1:${token.toLowerCase()}`]).toEqual({
      symbol: "TKN",
      decimals: 6,
      name: "Token",
    });
    expect(part.labels[alice]).toBe("alice");
    // The whole part is plain JSON.
    expect(JSON.parse(stringify(part))).toEqual(part);
  });

  test("records without enrichment when told to (nothing is read from the fork)", async () => {
    const fork = fakeFork();
    const recorder = new RunRecorder({
      runId: "unit",
      write: false,
      enrich: false,
      request: () => fork.request,
    });
    for (const event of events(1, 0)) recorder.handle(event);
    await observersSettled();
    expect(fork.calls).toEqual([]);
    expect(recorder.part.txs[0]).toMatchObject({
      status: "unknown",
      hash: HASH,
      call: { name: "transfer" },
    });
  });

  test("on an offline fork it reads no token metadata: the recording would not have it", async () => {
    const fork = fakeFork();
    const metadata = ["symbol()", "decimals()", "name()"].map((f) => toFunctionSelector(f));
    const asked: string[] = [];
    const request: RawRequest = (args) => {
      const data = (args.params?.[0] as { data?: string } | undefined)?.data;
      if (args.method === "eth_call" && data !== undefined) asked.push(data.slice(0, 10));
      return fork.request(args);
    };
    const recorder = new RunRecorder({ runId: "unit", write: false, request: () => request });
    const [boot, ...rest] = events(1, 0);
    if (boot?.type !== "fork:boot") throw new Error("events() starts with a fork:boot");
    const cache = { path: "/c/1/100.json", hits: 9, misses: 0, entries: 9, missesByMethod: {} };
    recorder.handle({ ...boot, cache: { ...cache, mode: "offline" } });
    for (const event of rest) recorder.handle(event);
    await observersSettled();
    expect(asked.filter((selector) => metadata.includes(selector as Hex))).toEqual([]);
    expect(recorder.part.tokens).toEqual({});
    // The transaction's own state is still read: its receipt, trace and balances.
    expect(fork.calls).toEqual(expect.arrayContaining(["debug_traceTransaction", "eth_call"]));
    expect(recorder.part.txs[0]?.balanceChanges.length).toBeGreaterThan(0);

    // A fork booted later on the same URL, with a writable cache, reads it again.
    recorder.handle({ ...boot, cache: { ...cache, mode: "readwrite" } });
    for (const event of events(2, 100).slice(1)) recorder.handle(event);
    await observersSettled();
    expect(asked.filter((selector) => metadata.includes(selector as Hex))).not.toEqual([]);
  });

  test("a fork that fails every read leaves notes, not errors", async () => {
    const recorder = new RunRecorder({
      runId: "unit",
      write: false,
      request: () => async () => {
        throw new Error("connection refused");
      },
    });
    for (const event of events(1, 0)) recorder.handle(event);
    await observersSettled();
    expect(recorder.part.txs[0]?.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("receipt: connection refused")]),
    );
    expect(recorder.part.txs[1]?.notes).toEqual(["trace: connection refused"]);
  });
});

describe("state diffs", () => {
  test("changed fields only: a zeroed slot, a new slot, a nonce; read-only state is not a change", () => {
    const diff = stateDiff({
      pre: {
        [vault]: {
          balance: "0x0",
          nonce: 1,
          code: "0x6000",
          storage: { "0x2": word(9n), "0x3": word(4n) },
        },
        [alice]: { balance: numberToHex(10n), nonce: 0 },
      },
      post: {
        [vault]: { storage: { "0x1": word(7n), "0x3": word(4n) } },
        [alice]: { nonce: 1 },
        [bob]: { balance: "0x5", code: "0x60016000" },
      },
    });
    expect(diff).toEqual([
      {
        address: bob,
        balance: { before: "0", after: "5" },
        code: { before: 0, after: 4 },
        storage: [],
      },
      { address: alice, nonce: { before: 0, after: 1 }, storage: [] },
      {
        address: vault,
        storage: [
          { slot: word(1n), before: word(0n), after: word(7n) },
          { slot: word(2n), before: word(9n), after: word(0n) },
        ],
      },
    ]);
  });

  test("names mapping slots, nested ones too, and small slots by number; labels given later win", () => {
    const namer = new SlotNamer();
    namer.add(alice, "alice");
    namer.add(bob);
    expect(namer.name(mappingSlot(alice, "0x9"))).toBe("mapping(9)[alice]");
    expect(namer.name(mappingSlot(bob, mappingSlot(alice, "0xa")))).toBe(
      "mapping(10)[alice][0x0000…0b0b]",
    );
    expect(namer.name(word(3n))).toBe("slot 3");
    expect(namer.name(keccak256("0x1234"))).toBeUndefined();
    namer.add(bob, "bob");
    expect(namer.name(mappingSlot(bob, "0x0"))).toBe("mapping(0)[bob]");
  });
});

describe("parts and merging", () => {
  /** Two workers of one run, each writing its own part. */
  async function recordTwoWorkers(dir: string): Promise<RunRecorder[]> {
    const recorders = [1, 2].map(
      () => new RunRecorder({ dir, runId: "merged", request: () => fakeFork().request }),
    );
    label(bob, "bob");
    for (const event of events(1, 2_000)) recorders[0]?.handle(event);
    label(alice, "alice");
    for (const event of events(2, 1_000)) recorders[1]?.handle(event);
    await observersSettled();
    return recorders;
  }

  test("each worker appends to its own part; merging makes one run, in time order", async () => {
    const dir = scratch();
    const [first, second] = await recordTwoWorkers(dir);
    expect(readdirSync(join(dir, "parts", "merged")).sort()).toEqual(
      [`${first?.part.worker}.jsonl`, `${second?.part.worker}.jsonl`].sort(),
    );
    const run = mergeRun(dir, "merged") as RunRecord;
    expect(run.id).toBe("merged");
    expect(run.version).toBe(1);
    expect(run.workers).toHaveLength(2);
    expect(run.tests.map((t) => t.name)).toEqual(["moves tokens 2", "moves tokens 1"]);
    expect(run.tests.map((t) => t.status)).toEqual(["fail", "pass"]);
    expect(run.tests[0]).toMatchObject({ error: "expected 1 to be 2", actual: "1", expected: "2" });
    expect(run.cheats?.map((c) => c.cheat)).toEqual([
      "prank",
      "stopPrank",
      "warp",
      "prank",
      "stopPrank",
      "warp",
    ]);
    expect(run.txs.map((t) => t.ts)).toEqual([1_003, 1_004, 2_003, 2_004]);
    expect(run.txs.every((t) => t.test !== undefined)).toBe(true);
    expect(new Set(run.txs.map((t) => t.id)).size).toBe(4);
    expect(run.txs[0]?.status).toBe("success");
    expect(run.forks).toHaveLength(2);
    expect(run.fills).toHaveLength(2);
    expect(run.labels).toEqual({ [alice]: "alice", [bob]: "bob" });
    expect(run.blocks).toEqual([
      {
        chainId: 1,
        number: "16",
        hash: BLOCK_HASH,
        timestamp: 1_700_000_000,
        txs: [run.txs[0]?.id, run.txs[2]?.id],
      },
    ]);
    expect(JSON.parse(readFileSync(runFile(dir, "merged"), "utf8"))).toEqual(run);
  });

  test("the enriched line of a transaction replaces its first line; a torn last line is skipped", async () => {
    const dir = scratch();
    const [first] = await recordTwoWorkers(dir);
    const file = join(dir, "parts", "merged", `${first?.part.worker}.jsonl`);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.filter((l) => l.includes('"kind":"tx"')).length).toBe(4);
    appendFileSync(file, '{"kind":"tx","record":{"id":');
    const part = parsePart(readFileSync(file, "utf8"));
    expect(part?.txs).toHaveLength(2);
    expect(part?.txs[0]?.status).toBe("success");
  });

  test("readRun re-merges when a part is newer than the run file, and listRuns summarizes", async () => {
    const dir = scratch();
    await recordTwoWorkers(dir);
    mergeRun(dir, "merged");
    const old = new Date(Date.now() - 60_000);
    utimesSync(runFile(dir, "merged"), old, old);
    const extra = new RunRecorder({ dir, runId: "merged", enrich: false });
    for (const event of events(3, 3_000)) extra.handle(event);
    const run = readRun(dir, "merged");
    expect(run?.tests).toHaveLength(3);
    expect(statSync(runFile(dir, "merged")).mtimeMs).toBeGreaterThan(old.getTime());
    expect(listRuns(dir)).toEqual([
      expect.objectContaining({
        id: "merged",
        tests: 3,
        passed: 2,
        failed: 1,
        txs: 6,
        fills: 3,
        chains: [{ chainId: 1, chainName: "Ethereum" }],
      }),
    ]);
  });

  test("a record from before cheats were recorded still merges and reads", () => {
    const dir = scratch();
    const recorder = new RunRecorder({ dir, runId: "older", enrich: false });
    for (const event of events(1, 1_000)) recorder.handle(event);
    const file = join(dir, "parts", "older", `${recorder.part.worker}.jsonl`);
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter((l) => !l.includes('"kind":"cheat"'));
    writeFileSync(file, `${lines.join("\n")}\n`);
    const run = mergeRun(dir, "older") as RunRecord;
    expect(run.cheats).toEqual([]);
    expect(run.txs).toHaveLength(2);
  });

  test("readRun refuses ids that could escape the directory", () => {
    const dir = scratch();
    expect(readRun(dir, "../etc")).toBeUndefined();
    expect(readRun(dir, "a/b")).toBeUndefined();
  });
});

describe("run ids", () => {
  test("FORKIT_RUN_ID wins, and must be a safe name", () => {
    const dir = scratch();
    expect(resolveRunId(dir, { FORKIT_RUN_ID: "ci-42" })).toBe("ci-42");
    expect(() => resolveRunId(dir, { FORKIT_RUN_ID: "../x" })).toThrow(/FORKIT_RUN_ID/);
  });

  test("workers of one runner share the run a pointer names; a stale pointer starts a new run", () => {
    const dir = scratch();
    const first = resolveRunId(dir, {}, Date.UTC(2026, 8, 28, 12));
    expect(first).toBe(`20260928T120000Z-${runnerPid({})}`);
    expect(resolveRunId(dir, {}, Date.UTC(2026, 8, 28, 13))).toBe(first);
    const pointer = join(dir, "parts", ".roots", String(runnerPid({})));
    const old = new Date(Date.UTC(2026, 8, 1));
    utimesSync(pointer, old, old);
    expect(resolveRunId(dir, {}, Date.UTC(2026, 8, 29, 12))).toBe(
      `20260929T120000Z-${runnerPid({})}`,
    );
  });

  test("FORKIT_RECORD turns recording on; 0, false and off do not", () => {
    expect(recordingEnabled({ FORKIT_RECORD: "1" })).toBe(true);
    expect(recordingEnabled({ FORKIT_RECORD: "true" })).toBe(true);
    for (const off of [undefined, "", "0", "false", "off", "no"]) {
      expect(recordingEnabled({ FORKIT_RECORD: off })).toBe(false);
    }
  });
});

describe("explore server", () => {
  test("serves the run list, runs and static UI, read-only, on 127.0.0.1", async () => {
    const dir = scratch();
    const recorder = new RunRecorder({ dir, runId: "served", request: () => fakeFork().request });
    for (const event of events(1, 1_000)) recorder.handle(event);
    await observersSettled();
    const file = join(scratch(), "copied.json");
    writeFileSync(
      file,
      stringify({ ...(mergeRun(dir, "served") as RunRecord), id: "from-file", startedAt: 1 }),
    );

    const server = await startExploreServer({ dir, files: [file] });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const get = (path: string, init?: RequestInit) => fetch(new URL(path, server.url), init);

      const list = await get("/api/runs");
      expect(list.status).toBe(200);
      expect(list.headers.get("content-type")).toContain("application/json");
      expect(((await list.json()) as { id: string }[]).map((r) => r.id)).toEqual([
        "served",
        "from-file",
      ]);

      const run = (await (await get("/api/runs/served")).json()) as RunRecord;
      expect(run.txs[0]).toMatchObject({ status: "success", gasUsed: "50000" });
      expect(((await (await get("/api/runs/from-file")).json()) as RunRecord).id).toBe("from-file");
      expect((await get("/api/runs/nope")).status).toBe(404);
      expect((await get("/api/runs/..%2F..%2Fetc")).status).toBe(404);

      const page = await get("/");
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await page.text();
      expect(html).toContain('<script type="module" src="/app.js">');
      expect(html).not.toMatch(/https?:\/\//);
      for (const [path, type] of [
        ["/app.js", "text/javascript"],
        ["/lib/model.js", "text/javascript"],
        ["/lib/dom.js", "text/javascript"],
        ["/views/tx.js", "text/javascript"],
        ["/app.css", "text/css"],
        ["/favicon.svg", "image/svg+xml"],
        ["/favicon-dark.svg", "image/svg+xml"],
      ] as const) {
        const asset = await get(path);
        expect(asset.status, path).toBe(200);
        expect(asset.headers.get("content-type")).toContain(type);
        // Nothing remote: the only URL allowed is SVG's namespace, which is never fetched.
        const text = (await asset.text()).replaceAll('"http://www.w3.org/2000/svg"', "");
        expect(text).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)[a-z]/i);
      }
      expect((await get("/server.ts")).status).toBe(404);
      // Only files under ui/ are served, by exact path: no traversal, no directories.
      expect((await get("/../server.ts")).status).toBe(404);
      expect((await get("/lib/%2e%2e/%2e%2e/server.ts")).status).toBe(404);
      expect((await get("/lib/")).status).toBe(404);
      // Every module the page imports is served (a missing one would blank the UI).
      const imports = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1] as string);
      const queue = [...imports];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const path = queue.shift() as string;
        if (seen.has(path)) continue;
        seen.add(path);
        const module = await get(path);
        expect(module.status, path).toBe(200);
        const text = await module.text();
        for (const m of text.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
          queue.push(new URL(m[1] as string, new URL(path, server.url)).pathname);
        }
      }
      expect(seen.size).toBeGreaterThan(5);
      expect((await get("/api/runs", { method: "POST" })).status).toBe(405);
      expect((await get("/api/runs", { method: "DELETE" })).status).toBe(405);
      // fetch cannot set Host; node:http can, as a DNS-rebinding page's request would arrive.
      const rebound = await new Promise<number | undefined>((resolve, reject) => {
        request(new URL("/api/runs", server.url), { headers: { host: "evil.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
          .on("error", reject)
          .end();
      });
      expect(rebound).toBe(421);
    } finally {
      await server.close();
    }
  });

  test("a file given explicitly wins over a record-dir run with the same id, in the list too", async () => {
    const dir = scratch();
    const recorder = new RunRecorder({ dir, runId: "same", request: () => fakeFork().request });
    for (const event of events(1, 1_000)) recorder.handle(event);
    await observersSettled();
    const file = join(scratch(), "same.json");
    writeFileSync(
      file,
      stringify({ ...(mergeRun(dir, "same") as RunRecord), id: "same", startedAt: 7 }),
    );
    const server = await startExploreServer({ dir, files: [file] });
    try {
      const list = (await (await fetch(`${server.url}api/runs`)).json()) as {
        id: string;
        startedAt: number;
      }[];
      expect(list.filter((r) => r.id === "same")).toEqual([
        expect.objectContaining({ startedAt: 7 }),
      ]);
      const run = (await (await fetch(`${server.url}api/runs/same`)).json()) as RunRecord;
      expect(run.startedAt).toBe(7);
    } finally {
      await server.close();
    }
  });
});

describe("forkit explore (the CLI)", () => {
  const CLI = resolve(import.meta.dirname, "../../src/explore/cli.ts");

  /** Run `forkit explore ...args` and return the URL it prints, then stop it. */
  const openedUrl = (args: string[]) =>
    new Promise<string>((ok, fail) => {
      const child = spawn(process.execPath, [CLI, "explore", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        fail(new Error(`no URL within 20 s. stdout: ${out} stderr: ${err}`));
      }, 20_000);
      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const url = /forkit explore: (\S+)/.exec(out)?.[1];
        if (url === undefined) return;
        clearTimeout(timer);
        child.kill();
        ok(url);
      });
      child.on("exit", (code) => {
        if (!/forkit explore: /.test(out)) {
          clearTimeout(timer);
          fail(new Error(`exited with ${code} before printing a URL: ${err}`));
        }
      });
    });

  test("explore <file> opens that file's run, even when the record dir has a newer one", async () => {
    // The CI-artifact workflow: a downloaded record, next to a local .forkit with newer runs.
    const dir = scratch();
    const recorder = new RunRecorder({
      dir,
      runId: "localrun",
      request: () => fakeFork().request,
    });
    for (const event of events(1, 1_000)) recorder.handle(event);
    await observersSettled();
    const newest = mergeRun(dir, "localrun") as RunRecord;
    const file = join(scratch(), "artifact.json");
    writeFileSync(
      file,
      stringify({ ...newest, id: "from-ci", startedAt: newest.startedAt - 60_000 }),
    );
    expect(listRuns(dir)[0]?.id).toBe("localrun");

    const url = await openedUrl([file, "--dir", dir]);
    expect(url).toMatch(/#\/run\/from-ci$/);
    // A file without an id opens under its file name.
    const unnamed = join(scratch(), "nameless-run.json");
    const { id: _id, ...withoutId } = { ...newest, startedAt: newest.startedAt - 60_000 };
    writeFileSync(unnamed, stringify(withoutId));
    expect(await openedUrl([unnamed, "--dir", dir])).toMatch(/#\/run\/nameless-run$/);
  });

  test("explore latest still opens the newest run in the record dir", async () => {
    const dir = scratch();
    const recorder = new RunRecorder({ dir, runId: "only", request: () => fakeFork().request });
    for (const event of events(1, 1_000)) recorder.handle(event);
    await observersSettled();
    expect(await openedUrl(["latest", "--dir", dir])).toMatch(/#\/run\/only$/);
  });
});
