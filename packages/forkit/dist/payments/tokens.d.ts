/**
 * Token quirks, handled on a fork:
 * - USDT on Ethereum reverts `approve` from a nonzero allowance to another nonzero one
 *   (`require(!((_value != 0) && (allowed[msg.sender][_spender] != 0)))`), so
 *   {@link forceApprove} sets zero first when it has to, like OpenZeppelin's `forceApprove`.
 * - USDT's `approve`, `transfer` and `transferFrom` return nothing, so anything that decodes the
 *   `bool` viem's `erc20Abi` declares fails on it. {@link forceApprove} and {@link safeTransfer}
 *   apply the SafeERC20 rule instead: no return data, or `true`, is success.
 * - Circle's FiatToken (USDC, EURC) has a blacklister and a pauser; {@link blacklist} and
 *   {@link pause} read the role from the token and prank it.
 *
 * These send transactions as someone, so they take the fork handle, and they send through the
 * fork's own client: gas is estimated first, a revert throws with its trace, and the reporter
 * and run records see every transaction.
 */
import { type Address, type Chain, type Hex } from "viem";
import type { Fork } from "../types.ts";
export interface ForceApproveParameters {
    token: Address;
    /** Approves; pranked. It pays the gas, so fund it with `f.dealNative` if it has no ETH. */
    owner: Address;
    spender: Address;
    amount: bigint;
}
/**
 * Set `owner`'s allowance for `spender` to exactly `amount`, whatever the token: like
 * OpenZeppelin's `forceApprove`, approve `amount` directly if the token accepts that, else
 * approve 0 first (USDT refuses a nonzero to nonzero approve). Resolves to the hash of the
 * approve that set `amount`, and whether the reset to 0 was needed.
 */
export declare function forceApprove<TChain extends Chain>(handle: Fork<TChain>, { token, owner, spender, amount }: ForceApproveParameters): Promise<{
    hash: Hex;
    reset: boolean;
}>;
export interface SafeTransferParameters {
    token: Address;
    /** Sends; pranked. It pays the gas, so fund it with `f.dealNative` if it has no ETH. */
    from: Address;
    to: Address;
    amount: bigint;
}
/**
 * `transfer` from `from` (pranked), with the SafeERC20 rule: tokens that return no `bool` (USDT)
 * pass, tokens that return `false` fail. Resolves to the transaction hash.
 */
export declare function safeTransfer<TChain extends Chain>(handle: Fork<TChain>, { token, from, to, amount }: SafeTransferParameters): Promise<Hex>;
/**
 * Blacklist `account` on a FiatToken (USDC, EURC): read `blacklister()`, prank it, call
 * `blacklist(account)`. Resolves to the blacklister.
 *
 * FiatTokenV2_2 keeps the blacklist flag in the top bit of the balance slot, so a later
 * `f.deal` of that token to `account` clears it. Deal first, then blacklist.
 */
export declare function blacklist<TChain extends Chain>(handle: Fork<TChain>, token: Address, account: Address): Promise<Address>;
/** Pause a FiatToken (USDC, EURC): read `pauser()`, prank it, call `pause()`. Resolves to the pauser. */
export declare function pause<TChain extends Chain>(handle: Fork<TChain>, token: Address): Promise<Address>;
//# sourceMappingURL=tokens.d.ts.map