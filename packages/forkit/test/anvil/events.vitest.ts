import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, parseEther } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Fork, type ForkitEvent, fork, onForkitEvent } from "../../src/index.ts";
import { VAULT_BYTECODE, vaultAbi } from "../fixtures/vault.ts";
import { startUpstream } from "./upstream.ts";

const alice: Address = "0x00000000000000000000000000000000000a11ce";
const dir = mkdtempSync(join(tmpdir(), "forkit-events-"));
const events: ForkitEvent[] = [];
const stop = onForkitEvent((e) => events.push(e));

let upstream: Awaited<ReturnType<typeof startUpstream>>;
let f: Fork<typeof foundry>;
let vault: Address;

beforeAll(async () => {
  upstream = await startUpstream();
  f = await fork({
    chain: foundry,
    forkUrl: upstream.url,
    blockNumber: 0n,
    cache: "off",
    gasSnapshot: "write",
    gasSnapshotFile: join(dir, ".gas-snapshot"),
  });
  const [deployer] = await f.client.getAddresses();
  const hash = await f.client.deployContract({
    abi: vaultAbi,
    bytecode: VAULT_BYTECODE,
    account: deployer as Address,
  });
  vault = (await f.client.waitForTransactionReceipt({ hash })).contractAddress as Address;
  await f.dealNative(alice, parseEther("5"));
});

afterAll(async () => {
  stop();
  await f?.stop();
  await upstream?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const ofType = <T extends ForkitEvent["type"]>(type: T) =>
  events.filter((e): e is Extract<ForkitEvent, { type: T }> => e.type === type);

test("fork:boot names the chain, block, masked upstream and boot time", () => {
  const [boot] = ofType("fork:boot");
  expect(boot).toMatchObject({ chainId: foundry.id, blockNumber: 0n, rpcUrl: f.rpcUrl });
  expect(boot?.bootMs).toBeGreaterThan(0);
});

test("tx:sent for each write, with kind, from, to, calldata and function name", async () => {
  const hash = await f.prank(alice, (c) =>
    c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value: 7n }),
  );
  const sent = ofType("tx:sent").find((e) => e.hash === hash);
  expect(sent).toMatchObject({
    kind: "writeContract",
    functionName: "deposit",
    value: 7n,
    to: vault,
  });
  expect(sent?.from?.toLowerCase()).toBe(alice);
  expect(ofType("tx:sent").some((e) => e.kind === "deployContract")).toBe(true);
});

test("tx:reverted with the message and the decoded trace", async () => {
  await f
    .prank(alice, (c) =>
      c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value: 0n }),
    )
    .catch(() => {});
  const [reverted] = ofType("tx:reverted");
  expect(reverted).toMatchObject({ kind: "writeContract", functionName: "deposit", to: vault });
  expect(reverted?.trace).toContain("Vault");
});

test("gas:snapshot with the committed value when there is one", async () => {
  const deposit = () =>
    f.prank(alice, (c) =>
      c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value: 1n }),
    );
  const first = await f.gasSnapshot("deposit", deposit);
  await f.gasSnapshot("deposit", deposit);
  const snaps = ofType("gas:snapshot").filter((e) => e.label === "deposit");
  expect(snaps[0]).toMatchObject({ gas: first, mode: "write" });
  expect(snaps[0]?.previous).toBeUndefined();
  expect(snaps[1]?.previous).toBe(first);
});

test("a listener that throws never breaks a test", async () => {
  const off = onForkitEvent(() => {
    throw new Error("observer bug");
  });
  await f.prank(alice, (c) =>
    c.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", value: 2n }),
  );
  off();
});
