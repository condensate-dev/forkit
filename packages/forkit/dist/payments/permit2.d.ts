/**
 * Permit2 signatures: SignatureTransfer (`permitTransferFrom`: one shot, unordered nonces) and
 * AllowanceTransfer (`permit`, then `transferFrom` against a time-boxed allowance).
 *
 * The canonical address comes from Uniswap's docs
 * (https://developers.uniswap.org/docs/protocols/v4/deployments); the type strings and the domain
 * from Permit2's source (`PermitHash.sol`, `EIP712.sol`) in https://github.com/Uniswap/permit2.
 */
import { type Address, type Client, type Hex, type LocalAccount, type TypedDataDomain } from "viem";
/**
 * Permit2's canonical address, the one Uniswap lists for Ethereum, Base and most other chains.
 * Where it lives elsewhere, pass `permit2`.
 */
export declare const PERMIT2: Address;
/** Where Permit2 lives, for a chain that has it elsewhere. */
export interface Permit2Options {
    /** Default: {@link PERMIT2}. */
    permit2?: Address;
}
/** A Permit2 unordered (SignatureTransfer) nonce derived from a fixed string. */
export declare function permit2Nonce(name: string): bigint;
/** Where an unordered nonce lives: bit `nonce & 0xff` of `nonceBitmap(owner, nonce >> 8)`. */
export declare function nonceBitmapPosition(nonce: bigint): {
    wordPos: bigint;
    bitPos: bigint;
};
/**
 * Permit2's EIP-712 domain, checked against its `DOMAIN_SEPARATOR()`. Permit2's domain has no
 * `version`: `EIP712Domain(string name,uint256 chainId,address verifyingContract)`. Labels Permit2
 * `"Permit2"` unless it has a label already.
 */
export declare function permit2Domain(client: Client, { permit2 }?: Permit2Options): Promise<TypedDataDomain>;
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
    permit: {
        permitted: {
            token: Address;
            amount: bigint;
        };
        nonce: bigint;
        deadline: bigint;
    };
}
/** Sign a SignatureTransfer `PermitTransferFrom` for one token. */
export declare function signPermitTransferFrom(client: Client, parameters: SignPermitTransferFromParameters): Promise<SignedPermitTransferFrom>;
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
    details: {
        token: Address;
        amount: bigint;
        expiration: number;
        nonce: number;
    };
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
export declare function signPermitSingle(client: Client, parameters: SignPermitSingleParameters): Promise<SignedPermitSingle>;
//# sourceMappingURL=permit2.d.ts.map