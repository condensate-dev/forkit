/**
 * Deterministic test keys, and EIP-2612 / EIP-3009 signatures built from what the token itself
 * reports: its EIP-712 domain and its nonces.
 *
 * - EIP-712: https://eips.ethereum.org/EIPS/eip-712
 * - EIP-2612: https://eips.ethereum.org/EIPS/eip-2612
 * - EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
 * - EIP-5267: https://eips.ethereum.org/EIPS/eip-5267
 */
import { type Address, type Client, type Hex, type LocalAccount, type PrivateKeyAccount, type TypedDataDomain } from "viem";
/** Label `address` with `name`, unless it already has a label. */
export declare function labelIfUnnamed(address: Address, name: string): void;
/**
 * A private-key account derived from a fixed string: its key is
 * `keccak256("forkit payments " + name)`. The same name gives the same key on every run, so
 * signatures, calldata and the state they touch are the same too, and a fork recording replays
 * offline. The address is labelled `name` (unless it has a label already), like forge-std's
 * `makeAddrAndKey`. The key is public: use it on forks only.
 */
export declare function testAccount(name: string): PrivateKeyAccount;
/**
 * An address derived from a fixed string, for payees, spenders and relayers: the last 20 bytes of
 * `keccak256("forkit payments address " + name)`. No one holds its key, so on the real chain it
 * has never sent a transaction and has no code. Labelled `name`, like forge-std's `makeAddr`.
 */
export declare function testAddress(name: string): Address;
/** An EIP-3009 `bytes32` nonce derived from a fixed string. EIP-3009 nonces are unordered. */
export declare function authorizationNonce(name: string): Hex;
/**
 * Read the EIP-712 domain `token` signs under: EIP-5267 `eip712Domain()` when the token has it,
 * else `name()`, `version()` (default `"1"`), the chain id and the token's address. When the
 * token has `DOMAIN_SEPARATOR()`, the domain is checked against it, so a signature never goes out
 * under a domain the token would not recognise. A transport error (or a fork cache miss) throws;
 * only a function the token does not have counts as absent.
 */
export declare function tokenDomain(client: Client, token: Address): Promise<TypedDataDomain>;
/** A signature three ways: the 65-byte blob, and `v`/`r`/`s` for the `(v, r, s)` overloads. */
export interface SplitSignature {
    signature: Hex;
    v: number;
    r: Hex;
    s: Hex;
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
export declare function signPermit(client: Client, parameters: SignPermitParameters): Promise<SignedPermit>;
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
/** Sign an EIP-3009 `TransferWithAuthorization`. Anyone may submit it. */
export declare function signTransferWithAuthorization(client: Client, parameters: SignAuthorizationParameters): Promise<SignedAuthorization>;
/**
 * Sign an EIP-3009 `ReceiveWithAuthorization`. Only the payee (`to`) may submit it, which stops a
 * front-runner from lifting the signature out of the mempool.
 */
export declare function signReceiveWithAuthorization(client: Client, parameters: SignAuthorizationParameters): Promise<SignedAuthorization>;
//# sourceMappingURL=sign.d.ts.map