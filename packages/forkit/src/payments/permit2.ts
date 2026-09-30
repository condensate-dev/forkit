/**
 * Permit2 signatures: SignatureTransfer (`permitTransferFrom`: one shot, unordered nonces) and
 * AllowanceTransfer (`permit`, then `transferFrom` against a time-boxed allowance).
 *
 * The canonical address comes from Uniswap's docs
 * (https://developers.uniswap.org/docs/protocols/v4/deployments); the type strings and the domain
 * from Permit2's source (`PermitHash.sol`, `EIP712.sol`) in https://github.com/Uniswap/permit2.
 */
import {
  type Address,
  type Client,
  domainSeparator,
  type Hex,
  keccak256,
  type LocalAccount,
  type TypedDataDomain,
  toHex,
} from "viem";
import { getChainId, getCode, readContract } from "viem/actions";
import { ForkitError } from "../errors.ts";
import { formatAddress } from "../labels.ts";
import { permit2Abi } from "./abi.ts";
import { labelIfUnnamed } from "./sign.ts";

/**
 * Permit2's canonical address, the one Uniswap lists for Ethereum, Base and most other chains.
 * Where it lives elsewhere, pass `permit2`.
 */
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** Where Permit2 lives, for a chain that has it elsewhere. */
export interface Permit2Options {
  /** Default: {@link PERMIT2}. */
  permit2?: Address;
}

/** A Permit2 unordered (SignatureTransfer) nonce derived from a fixed string. */
export function permit2Nonce(name: string): bigint {
  return BigInt(keccak256(toHex(`forkit payments permit2 ${name}`)));
}

/** Where an unordered nonce lives: bit `nonce & 0xff` of `nonceBitmap(owner, nonce >> 8)`. */
export function nonceBitmapPosition(nonce: bigint): { wordPos: bigint; bitPos: bigint } {
  return { wordPos: nonce >> 8n, bitPos: nonce & 0xffn };
}

/**
 * Permit2's EIP-712 domain, checked against its `DOMAIN_SEPARATOR()`. Permit2's domain has no
 * `version`: `EIP712Domain(string name,uint256 chainId,address verifyingContract)`. Labels Permit2
 * `"Permit2"` unless it has a label already.
 */
export async function permit2Domain(
  client: Client,
  { permit2 = PERMIT2 }: Permit2Options = {},
): Promise<TypedDataDomain> {
  labelIfUnnamed(permit2, "Permit2");
  const [chainId, code] = await Promise.all([
    getChainId(client),
    getCode(client, { address: permit2 }),
  ]);
  if (code === undefined || code === "0x") {
    throw new ForkitError(
      `forkit: Permit2 has no code at ${formatAddress(permit2)} on chain ${chainId}. Fork a block after its deployment, or pass \`permit2\` if it lives elsewhere on this chain.`,
    );
  }
  const domain = { name: "Permit2", chainId, verifyingContract: permit2 };
  const onChain = await readContract(client, {
    address: permit2,
    abi: permit2Abi,
    functionName: "DOMAIN_SEPARATOR",
  });
  const computed = domainSeparator({ domain });
  if (computed.toLowerCase() !== onChain.toLowerCase()) {
    throw new ForkitError(
      `forkit: ${formatAddress(permit2)} reports DOMAIN_SEPARATOR ${onChain}, but Permit2's would be ${computed}. Is it Permit2?`,
    );
  }
  return domain;
}

export interface SignPermitTransferFromParameters extends Permit2Options {
  /** Signs the permit. The token holder, who has approved Permit2 on the token. */
  owner: LocalAccount;
  token: Address;
  amount: bigint;
  /**
   * Who will call `permitTransferFrom`. The signature covers it, and Permit2 checks it against
   * `msg.sender`, so it is not in the calldata.
   */
  spender: Address;
  /** Unordered nonce, e.g. {@link permit2Nonce}`("order 1")`. */
  nonce: bigint;
  /** Unix seconds. Take it from the fork's block time, never from `Date.now()`. */
  deadline: bigint;
}

export interface SignedPermitTransferFrom {
  owner: Address;
  spender: Address;
  signature: Hex;
  domain: TypedDataDomain;
  /**
   * The `PermitTransferFrom` struct for
   * `permitTransferFrom(permit, { to, requestedAmount }, owner, signature)`.
   */
  permit: { permitted: { token: Address; amount: bigint }; nonce: bigint; deadline: bigint };
}

/** Sign a SignatureTransfer `PermitTransferFrom` for one token. */
export async function signPermitTransferFrom(
  client: Client,
  parameters: SignPermitTransferFromParameters,
): Promise<SignedPermitTransferFrom> {
  const { owner, token, amount, spender, nonce, deadline } = parameters;
  const domain = await permit2Domain(client, { permit2: parameters.permit2 ?? PERMIT2 });
  const permitted = { token, amount };
  const signature = await owner.signTypedData({
    domain,
    types: {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "PermitTransferFrom",
    message: { permitted, spender, nonce, deadline },
  });
  return {
    owner: owner.address,
    spender,
    signature,
    domain,
    permit: { permitted, nonce, deadline },
  };
}

export interface SignPermitSingleParameters extends Permit2Options {
  /** Signs the permit. The token holder, who has approved Permit2 on the token. */
  owner: LocalAccount;
  token: Address;
  /** A `uint160`. */
  amount: bigint;
  /** A `uint48`: unix seconds when the allowance lapses. */
  expiration: number;
  spender: Address;
  /** Unix seconds after which the signature cannot be used. From the fork's block time. */
  sigDeadline: bigint;
  /** Default: the current `allowance(owner, token, spender).nonce`. */
  nonce?: number;
}

/** Permit2's `PermitSingle` struct. */
export interface PermitSingle {
  details: { token: Address; amount: bigint; expiration: number; nonce: number };
  spender: Address;
  sigDeadline: bigint;
}

export interface SignedPermitSingle {
  owner: Address;
  signature: Hex;
  domain: TypedDataDomain;
  permitSingle: PermitSingle;
  /** Arguments for `permit(owner, permitSingle, signature)`. */
  args: readonly [Address, PermitSingle, Hex];
}

/** Sign an AllowanceTransfer `PermitSingle`. */
export async function signPermitSingle(
  client: Client,
  parameters: SignPermitSingleParameters,
): Promise<SignedPermitSingle> {
  const { owner, token, amount, expiration, spender, sigDeadline } = parameters;
  const permit2 = parameters.permit2 ?? PERMIT2;
  const domain = await permit2Domain(client, { permit2 });
  const nonce =
    parameters.nonce ??
    (
      await readContract(client, {
        address: permit2,
        abi: permit2Abi,
        functionName: "allowance",
        args: [owner.address, token, spender],
      })
    )[2];
  const permitSingle: PermitSingle = {
    details: { token, amount, expiration, nonce },
    spender,
    sigDeadline,
  };
  const signature = await owner.signTypedData({
    domain,
    types: {
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
    },
    primaryType: "PermitSingle",
    message: permitSingle,
  });
  return {
    owner: owner.address,
    signature,
    domain,
    permitSingle,
    args: [owner.address, permitSingle, signature],
  };
}
