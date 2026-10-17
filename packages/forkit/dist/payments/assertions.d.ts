/**
 * Payment-state expectations. Like forkit's core assertions they work in any runner, throw
 * {@link ForkitAssertionError} with `actual` and `expected`, and resolve to what they read. Every
 * one takes the token first, then the account, as ERC-20's own reads do.
 */
import { type Address, type Client, type Hex } from "viem";
import { type Permit2Options } from "./permit2.ts";
/** Assert `token.allowance(owner, spender) == expected`. */
export declare function expectAllowance(client: Client, token: Address, owner: Address, spender: Address, expected: bigint): Promise<bigint>;
/** Assert the EIP-2612 `nonces(owner)` of `token`: how many permits `owner` has used. */
export declare function expectPermitNonce(client: Client, token: Address, owner: Address, expected: bigint): Promise<bigint>;
/** Assert that an EIP-3009 authorization nonce has been used (or canceled): `authorizationState` is true. */
export declare function expectAuthorizationUsed(client: Client, token: Address, authorizer: Address, nonce: Hex): Promise<void>;
/** Assert that an EIP-3009 authorization nonce is still free: `authorizationState` is false. */
export declare function expectAuthorizationUnused(client: Client, token: Address, authorizer: Address, nonce: Hex): Promise<void>;
/** Assert that a Permit2 unordered (SignatureTransfer) nonce is spent: its bit in `nonceBitmap` is set. */
export declare function expectPermit2NonceUsed(client: Client, owner: Address, nonce: bigint, { permit2 }?: Permit2Options): Promise<void>;
/** Assert that a Permit2 unordered (SignatureTransfer) nonce is still free. */
export declare function expectPermit2NonceUnused(client: Client, owner: Address, nonce: bigint, { permit2 }?: Permit2Options): Promise<void>;
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
export declare function expectPermit2Allowance(client: Client, token: Address, owner: Address, spender: Address, expected: Partial<Permit2Allowance>, { permit2 }?: Permit2Options): Promise<Permit2Allowance>;
//# sourceMappingURL=assertions.d.ts.map