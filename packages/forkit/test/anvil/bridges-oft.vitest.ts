import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, getAddress, type Hex, keccak256, pad, parseEther, toHex } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { bridge, OftError, type OftOptions } from "../../src/bridges/index.ts";
import { type Fork, fork, type SnapshotId } from "../../src/index.ts";
import {
  COMPOSER_STUB_RUNTIME,
  LZ_ENDPOINT_STUB_RUNTIME,
  lzStubAbi,
  OFT_STUB_RUNTIME,
} from "../fixtures/layerzero.ts";
import { alice, startUpstreams } from "./adapter-contract.ts";
import { otherChain } from "./upstream.ts";

// bridge.oft on two local anvils. Each has a stub EndpointV2 and a stub OFT at the same
// addresses; the destination also has a stub composer. The stubs follow the public LayerZero v2
// packet and message layout (see test/fixtures/LayerZeroStubs.sol).

const endpoint = getAddress("0x00000000000000000000000000000000000e0d01");
const oftAddress = getAddress("0x00000000000000000000000000000000000000f7");
const composer = getAddress("0x00000000000000000000000000000000000c0353");
const bob = getAddress("0x0000000000000000000000000000000000000b0b");
const ORIGIN_EID = 40_001;
const DESTINATION_EID = 40_002;
const guidOf = (name: string): Hex => keccak256(toHex(`forkit oft guid ${name}`));

let upstreams: Awaited<ReturnType<typeof startUpstreams>>;
let f: Fork<typeof foundry>;
let snapshots: [Fork, SnapshotId][] = [];

beforeAll(async () => {
  upstreams = await startUpstreams();
  f = await fork([
    { chain: foundry, forkUrl: upstreams.a.url, blockNumber: 0n, cache: "off" },
    { chain: otherChain, forkUrl: upstreams.b.url, blockNumber: 0n, cache: "off" },
  ]);
  for (const [g, eid] of [
    [f, ORIGIN_EID],
    [f.on(otherChain), DESTINATION_EID],
  ] as const) {
    await g.dealNative(alice, parseEther("100"));
    await g.client.setCode({ address: endpoint, bytecode: LZ_ENDPOINT_STUB_RUNTIME });
    await g.client.setCode({ address: oftAddress, bytecode: OFT_STUB_RUNTIME });
    await g.prank(alice, async (c) => {
      await c.writeContract({
        address: endpoint,
        abi: lzStubAbi,
        functionName: "setEid",
        args: [eid],
      });
      await c.writeContract({
        address: oftAddress,
        abi: lzStubAbi,
        functionName: "setEndpoint",
        args: [endpoint],
      });
    });
  }
  await f.on(otherChain).client.setCode({ address: composer, bytecode: COMPOSER_STUB_RUNTIME });
});

beforeEach(async () => {
  await Promise.all(snapshots.map(([g, id]) => g.revertTo(id)));
  snapshots = await Promise.all(
    f.forks.map(async (g): Promise<[Fork, SnapshotId]> => [g, await g.snapshot()]),
  );
});

afterAll(async () => {
  await f?.stop();
  await upstreams?.stop();
});

const simulator = (options: Partial<OftOptions> = {}) =>
  bridge.oft(f, {
    ofts: { [foundry.id]: oftAddress },
    eids: { [foundry.id]: ORIGIN_EID, [otherChain.id]: DESTINATION_EID },
    ...options,
  });

const send = (
  guid: Hex,
  to: Address,
  amount: bigint,
  compose: Hex = "0x",
  dstEid = DESTINATION_EID,
) =>
  f.prank(alice, (c) =>
    c.writeContract({
      address: oftAddress,
      abi: lzStubAbi,
      functionName: "send",
      args: [guid, 1n, dstEid, pad(oftAddress), pad(to), amount, compose],
    }),
  );

const read = (address: Address, functionName: "balanceOf" | "calls", holder?: Address) =>
  functionName === "balanceOf"
    ? f.on(otherChain).client.readContract({
        address,
        abi: lzStubAbi,
        functionName,
        args: [holder ?? bob],
      })
    : f.on(otherChain).client.readContract({ address, abi: lzStubAbi, functionName });

test("a transfer: lzReceive runs as the endpoint, and the OFT credits the recipient", async () => {
  const oft = simulator();
  const guid = guidOf("plain");
  await send(guid, bob, 1_234n);
  const [fill, ...rest] = await oft.settle();
  expect(rest).toEqual([]);
  expect(await read(oftAddress, "balanceOf")).toBe(1_234n);
  expect(fill?.txHashes).toHaveLength(1);
  expect(fill?.outputAmount).toBe(1_234n);
  expect(fill?.destinationChainId).toBe(otherChain.id);
  expect(fill?.deposit.args).toMatchObject({ guid, dstEid: DESTINATION_EID, amountSentLD: 1_234n });
  expect(fill?.details).toMatchObject({
    guid,
    nonce: 1n,
    srcEid: ORIGIN_EID,
    oft: oftAddress,
    endpoint,
    recipient: bob,
    composed: false,
  });
  // The gas lent to the impersonated endpoint is taken back.
  expect(await f.on(otherChain).client.getBalance({ address: endpoint })).toBe(0n);
});

test("a composed transfer: lzCompose runs after lzReceive", async () => {
  const oft = simulator();
  await send(guidOf("composed"), composer, 50n, "0xbeef");
  const [fill] = await oft.settle();
  expect(fill?.txHashes).toHaveLength(2);
  expect(fill?.details).toMatchObject({ composed: true, recipient: composer });
  expect(await read(composer, "calls")).toBe(1n);
  expect(await read(oftAddress, "balanceOf", composer)).toBe(50n);
});

test("a failed compose is retried without a second lzReceive", async () => {
  const oft = simulator();
  const target = getAddress("0x00000000000000000000000000000000000c0354"); // no code yet
  await send(guidOf("retry"), target, 70n, "0xbeef");
  await expect(oft.settle()).rejects.toThrow();
  expect(await read(oftAddress, "balanceOf", target)).toBe(70n);
  await f.on(otherChain).client.setCode({ address: target, bytecode: COMPOSER_STUB_RUNTIME });
  const [fill] = await oft.settle();
  expect(fill?.txHashes).toHaveLength(2);
  expect(await read(target, "calls")).toBe(1n);
  expect(await read(oftAddress, "balanceOf", target)).toBe(70n);
});

test("the journal names each transfer by its guid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forkit-oft-"));
  try {
    const oft = simulator({ journalDir: dir });
    const guid = guidOf("journal");
    await send(guid, bob, 1n);
    await oft.settle();
    expect(readdirSync(dir)).toEqual([`oft-${guid}.json`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an eid with no chain id fails and names the option", async () => {
  const oft = simulator();
  await send(guidOf("far"), bob, 1n, "0x", 39_999);
  await expect(oft.settle()).rejects.toThrow(/eid 39999, which has no chain id. Pass eids/);
});

test("a destination that is not forked: deliver records it with no transaction", async () => {
  const oft = simulator({ unforkedDestination: "deliver" });
  await send(guidOf("base"), bob, 1n, "0x", 30_184); // Base's eid; Base is not in this fork
  const [fill] = await oft.settle();
  expect(fill).toMatchObject({ destinationChainId: 8453, unforked: true, txHashes: [] });
});

test("refuses no OFT and a shared eid", () => {
  expect(() => bridge.oft(f, { ofts: {} })).toThrow(OftError);
  expect(() =>
    bridge.oft(f, { ofts: { [foundry.id]: oftAddress }, eids: { [foundry.id]: 30_184 } }),
  ).toThrow(/eid 30184 is given to chains/);
});
