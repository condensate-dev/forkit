/**
 * Payment-state expectations. Like forkit's core assertions they work in any runner, throw
 * {@link ForkitAssertionError} with `actual` and `expected`, and resolve to what they read. Every
 * one takes the token first, then the account, as ERC-20's own reads do.
 */
import { type Address, type Client, erc20Abi, type Hex } from "viem";
import { readContract } from "viem/actions";
import { ForkitAssertionError } from "../errors.ts";
import { formatAddress } from "../labels.ts";
import { eip2612Abi, eip3009Abi, permit2Abi } from "./abi.ts";
import { nonceBitmapPosition, PERMIT2, type Permit2Options } from "./permit2.ts";

/** Assert `token.allowance(owner, spender) == expected`. */
export async function expectAllowance(
  client: Client,
  token: Address,
  owner: Address,
  spender: Address,
  expected: bigint,
): Promise<bigint> {
  const actual = await readContract(client, {
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
  if (actual !== expected) {
    throw new ForkitAssertionError(
      `forkit: expected ${formatAddress(owner)}'s allowance for ${formatAddress(spender)} on ${formatAddress(token)} to be ${expected}, but it is ${actual}.`,
      { actual, expected },
    );
  }
  return actual;
}

/** Assert the EIP-2612 `nonces(owner)` of `token`: how many permits `owner` has used. */
export async function expectPermitNonce(
  client: Client,
  token: Address,
  owner: Address,
  expected: bigint,
): Promise<bigint> {
  const actual = await readContract(client, {
    address: token,
    abi: eip2612Abi,
    functionName: "nonces",
    args: [owner],
  });
  if (actual !== expected) {
    throw new ForkitAssertionError(
      `forkit: expected ${formatAddress(owner)}'s permit nonce on ${formatAddress(token)} to be ${expected}, but it is ${actual}.`,
      { actual, expected },
    );
  }
  return actual;
}

async function expectAuthorizationState(
  client: Client,
  token: Address,
  authorizer: Address,
  nonce: Hex,
  used: boolean,
): Promise<void> {
  const actual = await readContract(client, {
    address: token,
    abi: eip3009Abi,
    functionName: "authorizationState",
    args: [authorizer, nonce],
  });
  if (actual !== used) {
    throw new ForkitAssertionError(
      `forkit: expected ${formatAddress(authorizer)}'s EIP-3009 authorization ${nonce} on ${formatAddress(token)} to be ${used ? "used" : "unused"}, but authorizationState is ${actual}.`,
      { actual, expected: used },
    );
  }
}

/** Assert that an EIP-3009 authorization nonce has been used (or canceled): `authorizationState` is true. */
export function expectAuthorizationUsed(
  client: Client,
  token: Address,
  authorizer: Address,
  nonce: Hex,
): Promise<void> {
  return expectAuthorizationState(client, token, authorizer, nonce, true);
}

/** Assert that an EIP-3009 authorization nonce is still free: `authorizationState` is false. */
export function expectAuthorizationUnused(
  client: Client,
  token: Address,
  authorizer: Address,
  nonce: Hex,
): Promise<void> {
  return expectAuthorizationState(client, token, authorizer, nonce, false);
}

async function expectBitmapNonce(
  client: Client,
  owner: Address,
  nonce: bigint,
  used: boolean,
  permit2: Address,
): Promise<void> {
  const { wordPos, bitPos } = nonceBitmapPosition(nonce);
  const word = await readContract(client, {
    address: permit2,
    abi: permit2Abi,
    functionName: "nonceBitmap",
    args: [owner, wordPos],
  });
  const actual = ((word >> bitPos) & 1n) === 1n;
  if (actual !== used) {
    throw new ForkitAssertionError(
      `forkit: expected ${formatAddress(owner)}'s Permit2 nonce ${nonce} to be ${used ? "used" : "unused"}, but bit ${bitPos} of nonceBitmap word ${wordPos} is ${actual ? 1 : 0}.`,
      { actual, expected: used },
    );
  }
}

/** Assert that a Permit2 unordered (SignatureTransfer) nonce is spent: its bit in `nonceBitmap` is set. */
export function expectPermit2NonceUsed(
  client: Client,
  owner: Address,
  nonce: bigint,
  { permit2 = PERMIT2 }: Permit2Options = {},
): Promise<void> {
  return expectBitmapNonce(client, owner, nonce, true, permit2);
}

/** Assert that a Permit2 unordered (SignatureTransfer) nonce is still free. */
export function expectPermit2NonceUnused(
  client: Client,
  owner: Address,
  nonce: bigint,
  { permit2 = PERMIT2 }: Permit2Options = {},
): Promise<void> {
  return expectBitmapNonce(client, owner, nonce, false, permit2);
}

/** A Permit2 AllowanceTransfer allowance, as `allowance(owner, token, spender)` returns it. */
export interface Permit2Allowance {
  amount: bigint;
  /** Unix seconds. */
  expiration: number;
  /** The next `PermitSingle` nonce for this owner, token and spender. */
  nonce: number;
}

/**
 * Assert Permit2's AllowanceTransfer allowance of `owner` for `spender` on `token`. Only the
 * fields given are compared.
 */
export async function expectPermit2Allowance(
  client: Client,
  token: Address,
  owner: Address,
  spender: Address,
  expected: Partial<Permit2Allowance>,
  { permit2 = PERMIT2 }: Permit2Options = {},
): Promise<Permit2Allowance> {
  const [amount, expiration, nonce] = await readContract(client, {
    address: permit2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, token, spender],
  });
  const actual: Permit2Allowance = { amount, expiration, nonce };
  const keys = (Object.keys(expected) as (keyof Permit2Allowance)[]).filter(
    (key) => expected[key] !== undefined,
  );
  if (keys.some((key) => expected[key] !== actual[key])) {
    const compared = Object.fromEntries(keys.map((key) => [key, actual[key]]));
    const show = (value: Partial<Permit2Allowance>) =>
      keys.map((key) => `${key} ${String(value[key])}`).join(", ");
    throw new ForkitAssertionError(
      `forkit: expected ${formatAddress(owner)}'s Permit2 allowance for ${formatAddress(spender)} on ${formatAddress(token)} to have ${show(expected)}, but it has ${show(actual)}.`,
      { actual: compared, expected: Object.fromEntries(keys.map((key) => [key, expected[key]])) },
    );
  }
  return actual;
}
