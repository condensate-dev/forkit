/**
 * forkit/svm cheatcodes against a real surfpool, forking a local offline surfnet that holds a
 * seeded wallet and a seeded SPL mint. No network.
 */
import { type Address, address, getAddressEncoder, lamports } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  associatedTokenAddress,
  DealError,
  ForkitError,
  programDataAddress,
  type Surfnet,
  SurfnetRpcError,
  surfnet,
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/svm/index.ts";
import { mintData, sendInstruction, testSigner } from "./fixtures.ts";
import { SEEDED, SEEDED_LAMPORTS, startUpstream } from "./upstream.ts";

// A mint that exists only on the upstream ("mainnet"), 6 decimals.
const MINT = address("5wEp8VBzyfoUvyv3aJKqmeVgxu4dN9q6nhi9j3cEcy1f");
const MINT_AUTHORITY = address("7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5");
const ALICE = address("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
// Programs every surfnet preloads (loader v2: their account data is the ELF itself).
const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const ASSOCIATED_TOKEN = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

let upstream: Surfnet;
let s: Surfnet;

async function programElf(program: Address): Promise<Uint8Array> {
  const { value } = await s.rpc.getAccountInfo(program, { encoding: "base64" }).send();
  if (value === null) throw new Error(`no ${program} on the surfnet`);
  return new Uint8Array(Buffer.from(value.data[0], "base64"));
}

beforeAll(async () => {
  upstream = await startUpstream();
  await upstream.setAccount(MINT, {
    lamports: 1_461_600n,
    owner: TOKEN_PROGRAM_ADDRESS,
    data: mintData(MINT_AUTHORITY, 6),
    executable: false,
    rentEpoch: 0n,
  });
  s = await surfnet({ rpcUrl: upstream.rpcUrl });
}, 90_000);
afterAll(async () => {
  await s?.stop();
  await upstream?.stop();
});

describe("setAccount", () => {
  test("writes lamports, data and owner", async () => {
    const target = address("CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8");
    await s.setAccount(target, {
      lamports: 2_000_000n,
      data: new Uint8Array([1, 2, 3, 250]),
      owner: TOKEN_PROGRAM_ADDRESS,
    });
    const { value } = await s.rpc.getAccountInfo(target, { encoding: "base64" }).send();
    expect(value?.lamports).toBe(2_000_000n);
    expect(value?.owner).toBe(TOKEN_PROGRAM_ADDRESS);
    expect([...Buffer.from(value?.data[0] ?? "", "base64")]).toEqual([1, 2, 3, 250]);
  });
});

describe("dealSol", () => {
  test("sets a forked wallet's balance exactly, on the fork only", async () => {
    await s.dealSol(SEEDED, 42_000_000_000n);
    expect((await s.rpc.getBalance(SEEDED).send()).value).toBe(42_000_000_000n);
    expect((await upstream.rpc.getBalance(SEEDED).send()).value).toBe(SEEDED_LAMPORTS);
  });

  test("a fresh wallet, and a u64 beyond 2^53 survives the round trip", async () => {
    const big = 2n ** 60n + 7n;
    await s.dealSol(ALICE, big);
    expect((await s.rpc.getBalance(ALICE).send()).value).toBe(lamports(big));
  });
});

describe("deal (SPL tokens)", () => {
  test("creates the owner's associated token account with exactly that amount", async () => {
    const ata = await s.deal(MINT, ALICE, 1_000_000n);
    expect(ata).toBe(await associatedTokenAddress(ALICE, MINT));
    const { value } = await s.rpc.getTokenAccountBalance(ata).send();
    expect(value.amount).toBe("1000000");
    expect(value.decimals).toBe(6);
  });

  test("overwrites, not adds", async () => {
    const ata = await s.deal(MINT, ALICE, 5n);
    expect((await s.rpc.getTokenAccountBalance(ata).send()).value.amount).toBe("5");
  });

  test("refuses an account that is not a mint, and one that does not exist", async () => {
    await expect(s.deal(SEEDED, ALICE, 1n)).rejects.toBeInstanceOf(DealError);
    const nowhere = address("3Kn5L9hL9xMFbHy2WwAZeyT9bDGfHz3MUs8TSGLRNP4u");
    await expect(s.deal(nowhere, ALICE, 1n)).rejects.toThrow(/does not exist/);
  });
});

describe("clock: warp, roll, warpTo, pause", () => {
  test("warp moves the Clock sysvar forward by at least that many seconds", async () => {
    const before = await s.clock();
    const after = await s.warp(3_600);
    expect(after.unixTimestamp).toBeGreaterThanOrEqual(before.unixTimestamp + 3_600n);
  });

  test("roll moves forward that many slots", async () => {
    const before = await s.clock();
    const after = await s.roll(1_000);
    expect(after.slot).toBeGreaterThanOrEqual(before.slot + 1_000n);
  });

  test("warpTo an absolute slot; the past is refused", async () => {
    const now = await s.clock();
    const info = await s.warpTo({ slot: now.slot + 5_000n });
    expect(BigInt(info.absoluteSlot)).toBe(now.slot + 5_000n);
    await expect(s.warpTo({ slot: 1n })).rejects.toBeInstanceOf(SurfnetRpcError);
  });

  test("pauseClock holds the slot, resumeClock lets it go", async () => {
    await s.pauseClock();
    const paused = await s.rpc.getSlot().send();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await s.rpc.getSlot().send()).toBe(paused);
    await s.resumeClock();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await s.rpc.getSlot().send()).toBeGreaterThan(paused);
  });

  test("a negative warp is refused before it reaches surfpool", async () => {
    await expect(s.warp(-1)).rejects.toBeInstanceOf(ForkitError);
  });
});

describe("etch", () => {
  const ETCHED = address("Etch1111111111111111111111111111111111111111");

  test("deploys a .so at an address, and the program runs there", async () => {
    await s.etch(ETCHED, await programElf(MEMO));
    const payer = await testSigner(7);
    await s.dealSol(payer.address, 1_000_000_000n);
    const logs = await sendInstruction(s, payer, ETCHED, new TextEncoder().encode("hello"));
    expect(logs.join("\n")).toContain(`Program ${ETCHED} invoke`);
    expect(logs).toContain(`Program ${ETCHED} success`);
    expect(logs).toContain("Program log: Memo (len 5)");
    expect(logs).toContain("Program log: hello");
  });

  test("a smaller program over a bigger one: the old tail is zeroed and it still runs", async () => {
    const target = address("Etch2222222222222222222222222222222222222222");
    const big = await programElf(ASSOCIATED_TOKEN);
    const small = await programElf(MEMO);
    expect(big.length).toBeGreaterThan(small.length);
    await s.etch(target, big);
    await s.etch(target, small);
    const { value } = await s.rpc
      .getAccountInfo(await programDataAddress(target), { encoding: "base64" })
      .send();
    const image = Buffer.from(value?.data[0] ?? "", "base64").subarray(45);
    expect(image.subarray(0, small.length).equals(Buffer.from(small))).toBe(true);
    expect(image.subarray(small.length).every((b) => b === 0)).toBe(true);
    const payer = await testSigner(8);
    await s.dealSol(payer.address, 1_000_000_000n);
    const logs = await sendInstruction(s, payer, target, new TextEncoder().encode("again"));
    expect(logs).toContain(`Program ${target} success`);
    expect(logs).toContain("Program log: again");
  });

  test("sets, then clears, the upgrade authority", async () => {
    const target = address("Etch3333333333333333333333333333333333333333");
    await s.etch(target, await programElf(MEMO), { authority: MINT_AUTHORITY });
    const authority = async () => {
      const { value } = await s.rpc
        .getAccountInfo(await programDataAddress(target), {
          encoding: "base64",
          dataSlice: { offset: 12, length: 33 },
        })
        .send();
      const bytes = Buffer.from(value?.data[0] ?? "", "base64");
      return bytes[0] === 0 ? null : bytes.subarray(1);
    };
    const expected = Buffer.from(getAddressEncoder().encode(MINT_AUTHORITY));
    expect(Buffer.from((await authority()) ?? []).equals(expected)).toBe(true);
    await s.setProgramAuthority(target, null);
    expect(await authority()).toBe(null);
  });

  test("refuses bytes that are not an ELF", async () => {
    await expect(s.etch(ETCHED, new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(/not an ELF/);
  });
});

describe("reset", () => {
  test("reset(account) puts one account back to the fork source's state", async () => {
    await s.dealSol(SEEDED, 1n);
    await s.reset(SEEDED);
    expect((await s.rpc.getBalance(SEEDED).send()).value).toBe(SEEDED_LAMPORTS);
  });

  test("reset() drops every local change", async () => {
    const fresh = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    await s.dealSol(fresh, 123_456n);
    await s.dealSol(SEEDED, 1n);
    await s.reset();
    expect((await s.rpc.getBalance(fresh).send()).value).toBe(0n);
    expect((await s.rpc.getBalance(SEEDED).send()).value).toBe(SEEDED_LAMPORTS);
  });
});
