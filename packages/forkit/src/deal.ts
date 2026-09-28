import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  keccak256,
  numberToHex,
  parseAbi,
} from "viem";
import { type ForkClient, rawRequest } from "./client.ts";
import { DealError } from "./errors.ts";

export const erc20BalanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** How `deal` writes an ERC-20 balance. */
export type DealStrategy = "auto" | "anvil_dealERC20" | "storage";

export interface DealOptions {
  /**
   * `auto` (default) tries `anvil_dealERC20`, then falls back to storage-slot discovery.
   * `storage` always discovers and writes the balance slot directly.
   */
  via?: DealStrategy;
}

const MAX_BRUTE_FORCE_SLOT = 100n;

export async function readBalance(client: ForkClient, token: Address, holder: Address) {
  return await client.readContract({
    address: token,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [holder],
  });
}

function isMethodNotFound(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error);
  return /method not found|does not exist|not supported|unknown method|-32601/i.test(text);
}

function toWord(value: bigint): Hex {
  return numberToHex(value, { size: 32 });
}

/** A value that is very unlikely to be anyone's real balance. */
function probeFor(slot: Hex): bigint {
  return (BigInt(keccak256(slot)) >> 128n) | 1n;
}

async function slotHoldsBalance(
  client: ForkClient,
  token: Address,
  holder: Address,
  slot: Hex,
): Promise<boolean> {
  const original = (await client.getStorageAt({ address: token, slot })) ?? toWord(0n);
  const probe = probeFor(slot);
  await client.setStorageAt({ address: token, index: slot, value: toWord(probe) });
  let matches = false;
  try {
    matches = (await readBalance(client, token, holder)) === probe;
  } catch {
    // Overwriting e.g. a proxy implementation slot makes balanceOf revert: not our slot.
  } finally {
    await client.setStorageAt({ address: token, index: slot, value: original });
  }
  return matches;
}

/** Candidate slots, most likely first: what `balanceOf(holder)` actually reads, then common layouts. */
async function* candidateSlots(
  client: ForkClient,
  token: Address,
  holder: Address,
): AsyncGenerator<Hex> {
  const seen = new Set<string>();
  try {
    const { accessList } = await client.createAccessList({
      to: token,
      data: encodeFunctionData({ abi: erc20BalanceAbi, functionName: "balanceOf", args: [holder] }),
    });
    for (const entry of accessList) {
      if (entry.address.toLowerCase() !== token.toLowerCase()) continue;
      for (const key of entry.storageKeys) {
        seen.add(key.toLowerCase());
        yield key;
      }
    }
    // The access list is exactly what balanceOf reads: if none of it matched, no layout will.
    return;
  } catch {
    // No access list support: fall through to searching common mapping layouts.
  }
  for (let index = 0n; index < MAX_BRUTE_FORCE_SLOT; index++) {
    // Solidity: keccak256(key . slot). Vyper: keccak256(slot . key).
    for (const slot of [
      keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, index])),
      keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [index, holder])),
    ]) {
      if (seen.has(slot)) continue;
      seen.add(slot);
      yield slot;
    }
  }
}

/** Find the storage slot that backs `balanceOf(holder)`, or `undefined` if none does. */
export async function findBalanceSlot(
  client: ForkClient,
  token: Address,
  holder: Address,
): Promise<Hex | undefined> {
  for await (const slot of candidateSlots(client, token, holder)) {
    if (await slotHoldsBalance(client, token, holder, slot)) return slot;
  }
  return undefined;
}

/** Set `holder`'s balance of `token` to exactly `amount`, then read it back. */
export async function dealErc20(
  client: ForkClient,
  token: Address,
  holder: Address,
  amount: bigint,
  options: DealOptions = {},
): Promise<void> {
  if (amount < 0n) throw new DealError(`forkit: deal amount must be >= 0, got ${amount}`);
  const via = options.via ?? "auto";
  let dealMethodMissing = false;
  let anvilDealFailed = false;

  if (via !== "storage") {
    try {
      await rawRequest(client)({
        method: "anvil_dealERC20",
        // anvil_dealERC20(holder, token, amount): holder first.
        params: [holder, token, numberToHex(amount)],
      });
    } catch (error) {
      dealMethodMissing = isMethodNotFound(error);
      if (via === "anvil_dealERC20") {
        throw new DealError(
          dealMethodMissing
            ? "forkit: this anvil build has no anvil_dealERC20. Run `foundryup` to update foundry."
            : `forkit: anvil_dealERC20 failed for ${token}.`,
          { cause: error },
        );
      }
      // `auto`: anvil's own slot search misses some layouts; try forkit's.
      anvilDealFailed = true;
    }
  }

  if (via === "storage" || anvilDealFailed) {
    const slot = await findBalanceSlot(client, token, holder);
    if (slot === undefined) {
      throw new DealError(
        [
          `forkit: could not find the storage slot behind ${token}.balanceOf(${holder}).`,
          "The token's balance is probably derived (rebasing tokens such as stETH, aTokens,",
          "shares-based vaults), so it cannot be written directly. Deal the underlying asset or",
          "acquire the token through the protocol instead.",
          dealMethodMissing ? "Updating foundry (`foundryup`) enables anvil_dealERC20." : "",
        ]
          .filter((line) => line !== "")
          .join("\n"),
      );
    }
    await client.setStorageAt({ address: token, index: slot, value: toWord(amount) });
  }

  const actual = await readBalance(client, token, holder);
  if (actual !== amount) {
    throw new DealError(
      [
        `forkit: deal(${token}, ${holder}, ${amount}) left balanceOf = ${actual}.`,
        "The token's balance is derived or rebasing (e.g. stETH, aTokens), so writing storage",
        "does not produce an exact balance. Deal the underlying asset instead.",
      ].join("\n"),
    );
  }
}
