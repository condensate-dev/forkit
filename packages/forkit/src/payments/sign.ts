/**
 * Deterministic test keys, and EIP-2612 / EIP-3009 signatures built from what the token itself
 * reports: its EIP-712 domain and its nonces.
 *
 * - EIP-712: https://eips.ethereum.org/EIPS/eip-712
 * - EIP-2612: https://eips.ethereum.org/EIPS/eip-2612
 * - EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
 * - EIP-5267: https://eips.ethereum.org/EIPS/eip-5267
 */
import {
  type Address,
  type Client,
  domainSeparator,
  getAddress,
  type Hex,
  hexToNumber,
  keccak256,
  type LocalAccount,
  type PrivateKeyAccount,
  parseSignature,
  slice,
  type TypedDataDomain,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChainId, readContract } from "viem/actions";
import { ForkitError } from "../errors.ts";
import { formatAddress, label, labelOf } from "../labels.ts";
import { eip2612Abi } from "./abi.ts";
import { optional } from "./read.ts";

/** Label `address` with `name`, unless it already has a label. */
export function labelIfUnnamed(address: Address, name: string): void {
  if (labelOf(address) === undefined) label(address, name);
}

/**
 * A private-key account derived from a fixed string: its key is
 * `keccak256("forkit payments " + name)`. The same name gives the same key on every run, so
 * signatures, calldata and the state they touch are the same too, and a fork recording replays
 * offline. The address is labelled `name` (unless it has a label already), like forge-std's
 * `makeAddrAndKey`. The key is public: use it on forks only.
 */
export function testAccount(name: string): PrivateKeyAccount {
  const account = privateKeyToAccount(keccak256(toHex(`forkit payments ${name}`)));
  labelIfUnnamed(account.address, name);
  return account;
}

/**
 * An address derived from a fixed string, for payees, spenders and relayers: the last 20 bytes of
 * `keccak256("forkit payments address " + name)`. No one holds its key, so on the real chain it
 * has never sent a transaction and has no code. Labelled `name`, like forge-std's `makeAddr`.
 */
export function testAddress(name: string): Address {
  const address = getAddress(slice(keccak256(toHex(`forkit payments address ${name}`)), 12));
  labelIfUnnamed(address, name);
  return address;
}

/** An EIP-3009 `bytes32` nonce derived from a fixed string. EIP-3009 nonces are unordered. */
export function authorizationNonce(name: string): Hex {
  return keccak256(toHex(`forkit payments eip3009 ${name}`));
}

/** The domain an EIP-5267 `eip712Domain()` describes, with only the fields its bitmap marks. */
function eip5267Domain(
  token: Address,
  chainId: number,
  reported: readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]],
): TypedDataDomain {
  const [fields, name, version, reportedChainId, verifyingContract, salt, extensions] = reported;
  if (extensions.length > 0) {
    throw new ForkitError(
      `forkit: the EIP-712 domain of ${formatAddress(token)} uses extensions (EIP-${extensions.join(", EIP-")}), which forkit cannot build. Pass the domain explicitly.`,
    );
  }
  const bits = hexToNumber(fields);
  if ((bits & 4) !== 0 && Number(reportedChainId) !== chainId) {
    throw new ForkitError(
      `forkit: ${formatAddress(token)} reports an EIP-712 domain for chain ${reportedChainId}, but this is chain ${chainId}.`,
    );
  }
  return {
    ...((bits & 1) !== 0 ? { name } : {}),
    ...((bits & 2) !== 0 ? { version } : {}),
    ...((bits & 4) !== 0 ? { chainId } : {}),
    ...((bits & 8) !== 0 ? { verifyingContract } : {}),
    ...((bits & 16) !== 0 ? { salt } : {}),
  };
}

/**
 * Read the EIP-712 domain `token` signs under: EIP-5267 `eip712Domain()` when the token has it,
 * else `name()`, `version()` (default `"1"`), the chain id and the token's address. When the
 * token has `DOMAIN_SEPARATOR()`, the domain is checked against it, so a signature never goes out
 * under a domain the token would not recognise. A transport error (or a fork cache miss) throws;
 * only a function the token does not have counts as absent.
 */
export async function tokenDomain(client: Client, token: Address): Promise<TypedDataDomain> {
  const chainId = await getChainId(client);
  const read = <const TName extends "name" | "version" | "DOMAIN_SEPARATOR" | "eip712Domain">(
    functionName: TName,
  ) => optional(() => readContract(client, { address: token, abi: eip2612Abi, functionName }));

  let domain: TypedDataDomain;
  const reported = await read("eip712Domain");
  if (reported !== undefined) {
    domain = eip5267Domain(token, chainId, reported);
  } else {
    const name = await read("name");
    if (name === undefined) {
      throw new ForkitError(
        `forkit: ${formatAddress(token)} has neither eip712Domain() nor name(); is it a token with permits? Pass the domain explicitly.`,
      );
    }
    domain = { name, version: (await read("version")) ?? "1", chainId, verifyingContract: token };
  }

  const onChain = await read("DOMAIN_SEPARATOR");
  if (onChain !== undefined) {
    const computed = domainSeparator({ domain });
    if (computed.toLowerCase() !== onChain.toLowerCase()) {
      throw new ForkitError(
        `forkit: the EIP-712 domain read from ${formatAddress(token)} (${JSON.stringify(domain)}) hashes to ${computed}, but the token's DOMAIN_SEPARATOR() is ${onChain}. Pass the domain explicitly.`,
      );
    }
  }
  return domain;
}

/** A signature three ways: the 65-byte blob, and `v`/`r`/`s` for the `(v, r, s)` overloads. */
export interface SplitSignature {
  signature: Hex;
  v: number;
  r: Hex;
  s: Hex;
}

function splitSignature(signature: Hex): SplitSignature {
  const { r, s, v, yParity } = parseSignature(signature);
  return { signature, r, s, v: v === undefined ? 27 + yParity : Number(v) };
}

export interface SignPermitParameters {
  token: Address;
  /** Signs the permit. The token holder. */
  owner: LocalAccount;
  spender: Address;
  value: bigint;
  /** Unix seconds. Take it from the fork's block time, never from `Date.now()`. */
  deadline: bigint;
  /** Default: the token's `nonces(owner)`. */
  nonce?: bigint;
  /** Default: read from the token (see {@link tokenDomain}). */
  domain?: TypedDataDomain;
}

export interface SignedPermit extends SplitSignature {
  owner: Address;
  spender: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
  domain: TypedDataDomain;
  /** Arguments for `permit(owner, spender, value, deadline, v, r, s)`. */
  args: readonly [Address, Address, bigint, bigint, number, Hex, Hex];
}

/** Sign an EIP-2612 `Permit(owner, spender, value, nonce, deadline)`. */
export async function signPermit(
  client: Client,
  parameters: SignPermitParameters,
): Promise<SignedPermit> {
  const { token, owner, spender, value, deadline } = parameters;
  const domain = parameters.domain ?? (await tokenDomain(client, token));
  const nonce =
    parameters.nonce ??
    (await readContract(client, {
      address: token,
      abi: eip2612Abi,
      functionName: "nonces",
      args: [owner.address],
    }));
  const signature = await owner.signTypedData({
    domain,
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: owner.address, spender, value, nonce, deadline },
  });
  const parts = splitSignature(signature);
  return {
    ...parts,
    owner: owner.address,
    spender,
    value,
    nonce,
    deadline,
    domain,
    args: [owner.address, spender, value, deadline, parts.v, parts.r, parts.s],
  };
}

export interface SignAuthorizationParameters {
  token: Address;
  /** Signs the authorization. The payer. */
  from: LocalAccount;
  to: Address;
  value: bigint;
  /** Unix seconds. Default 0: valid at once. */
  validAfter?: bigint;
  /** Unix seconds. Take it from the fork's block time, never from `Date.now()`. */
  validBefore: bigint;
  /** A fixed `bytes32`, e.g. {@link authorizationNonce}`("invoice 1")`. Never random. */
  nonce: Hex;
  /** Default: read from the token (see {@link tokenDomain}). */
  domain?: TypedDataDomain;
}

export interface SignedAuthorization extends SplitSignature {
  kind: "TransferWithAuthorization" | "ReceiveWithAuthorization";
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  domain: TypedDataDomain;
  /**
   * Arguments for `transferWithAuthorization` or `receiveWithAuthorization`
   * `(from, to, value, validAfter, validBefore, nonce, v, r, s)`.
   */
  args: readonly [Address, Address, bigint, bigint, bigint, Hex, number, Hex, Hex];
}

const AUTHORIZATION_FIELDS = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

async function signAuthorization(
  kind: SignedAuthorization["kind"],
  client: Client,
  parameters: SignAuthorizationParameters,
): Promise<SignedAuthorization> {
  const { token, from, to, value, validBefore, nonce } = parameters;
  const validAfter = parameters.validAfter ?? 0n;
  const domain = parameters.domain ?? (await tokenDomain(client, token));
  const message = { from: from.address, to, value, validAfter, validBefore, nonce };
  const signature =
    kind === "TransferWithAuthorization"
      ? await from.signTypedData({
          domain,
          types: { TransferWithAuthorization: AUTHORIZATION_FIELDS },
          primaryType: kind,
          message,
        })
      : await from.signTypedData({
          domain,
          types: { ReceiveWithAuthorization: AUTHORIZATION_FIELDS },
          primaryType: kind,
          message,
        });
  const parts = splitSignature(signature);
  return {
    ...parts,
    kind,
    ...message,
    domain,
    args: [from.address, to, value, validAfter, validBefore, nonce, parts.v, parts.r, parts.s],
  };
}

/** Sign an EIP-3009 `TransferWithAuthorization`. Anyone may submit it. */
export function signTransferWithAuthorization(
  client: Client,
  parameters: SignAuthorizationParameters,
): Promise<SignedAuthorization> {
  return signAuthorization("TransferWithAuthorization", client, parameters);
}

/**
 * Sign an EIP-3009 `ReceiveWithAuthorization`. Only the payee (`to`) may submit it, which stops a
 * front-runner from lifting the signature out of the mempool.
 */
export function signReceiveWithAuthorization(
  client: Client,
  parameters: SignAuthorizationParameters,
): Promise<SignedAuthorization> {
  return signAuthorization("ReceiveWithAuthorization", client, parameters);
}
