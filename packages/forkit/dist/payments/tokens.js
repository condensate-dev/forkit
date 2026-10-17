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
import { encodeFunctionData, hexToBigInt, parseEther, size, slice, } from "viem";
import { getBalance, readContract } from "viem/actions";
import { ForkitError } from "../errors.js";
import { formatAddress } from "../labels.js";
import { isRevertError } from "../revert.js";
import { fiatTokenAdminAbi, noReturnErc20Abi } from "./abi.js";
import { optional } from "./read.js";
/**
 * Check a token call the way OpenZeppelin's SafeERC20 does, with `eth_call` (a mined
 * transaction's return data is not observable): it must not revert, and it must return nothing
 * from a contract, or a first word of 1 (`true`). A revert throws the token's own error.
 */
async function checkTokenCall(c, token, data, what) {
    const { data: returned = "0x" } = await c.call({ to: token, data });
    if (size(returned) === 0) {
        const code = await c.getCode({ address: token });
        if (code === undefined || code === "0x") {
            throw new ForkitError(`forkit: ${what}: ${formatAddress(token)} has no code.`);
        }
        return;
    }
    if (size(returned) < 32 || hexToBigInt(slice(returned, 0, 32)) !== 1n) {
        throw new ForkitError(`forkit: ${what}: ${formatAddress(token)} returned ${returned}, which is neither nothing nor true.`);
    }
}
/** Check `data` with {@link checkTokenCall}, then send it as a transaction from the pranked account. */
async function sendTokenCall(c, token, data, what) {
    await checkTokenCall(c, token, data, what);
    return c.sendTransaction({ to: token, data });
}
/**
 * Whether the token accepts `data` ({@link checkTokenCall}). A revert, or a return value other
 * than nothing or `true`, is the token saying no; a failed request (the RPC, the fork cache)
 * throws.
 */
async function accepts(c, token, data) {
    try {
        await checkTokenCall(c, token, data, "forceApprove");
        return true;
    }
    catch (error) {
        if (error instanceof ForkitError || isRevertError(error))
            return false;
        throw error;
    }
}
/**
 * Set `owner`'s allowance for `spender` to exactly `amount`, whatever the token: like
 * OpenZeppelin's `forceApprove`, approve `amount` directly if the token accepts that, else
 * approve 0 first (USDT refuses a nonzero to nonzero approve). Resolves to the hash of the
 * approve that set `amount`, and whether the reset to 0 was needed.
 */
export async function forceApprove(handle, { token, owner, spender, amount }) {
    // Chain-agnostic calls only; the chain-typed client is invariant in TChain.
    const f = handle;
    const approve = (value) => encodeFunctionData({ abi: noReturnErc20Abi, functionName: "approve", args: [spender, value] });
    return f.prank(owner, async (c) => {
        if (await accepts(c, token, approve(amount))) {
            return { hash: await c.sendTransaction({ to: token, data: approve(amount) }), reset: false };
        }
        await sendTokenCall(c, token, approve(0n), "forceApprove (reset to 0)");
        return { hash: await sendTokenCall(c, token, approve(amount), "forceApprove"), reset: true };
    });
}
/**
 * `transfer` from `from` (pranked), with the SafeERC20 rule: tokens that return no `bool` (USDT)
 * pass, tokens that return `false` fail. Resolves to the transaction hash.
 */
export function safeTransfer(handle, { token, from, to, amount }) {
    const f = handle;
    const data = encodeFunctionData({
        abi: noReturnErc20Abi,
        functionName: "transfer",
        args: [to, amount],
    });
    return f.prank(from, (c) => sendTokenCall(c, token, data, "safeTransfer"));
}
/** What a pranked admin gets for gas when it holds less than {@link GAS_FLOOR}. */
const ADMIN_GAS = parseEther("1");
const GAS_FLOOR = parseEther("0.1");
/**
 * Read `role` from a FiatToken and make sure it can pay for gas. A role holder with enough ETH
 * keeps its real balance.
 */
async function roleHolder(f, token, role, helper) {
    const admin = await optional(() => readContract(f.client, { address: token, abi: fiatTokenAdminAbi, functionName: role }));
    if (admin === undefined) {
        throw new ForkitError(`forkit: ${helper}: ${formatAddress(token)} has no ${role}(). ${helper} works with Circle's FiatToken (USDC, EURC).`);
    }
    if ((await getBalance(f.client, { address: admin })) < GAS_FLOOR) {
        await f.dealNative(admin, ADMIN_GAS);
    }
    return admin;
}
/**
 * Blacklist `account` on a FiatToken (USDC, EURC): read `blacklister()`, prank it, call
 * `blacklist(account)`. Resolves to the blacklister.
 *
 * FiatTokenV2_2 keeps the blacklist flag in the top bit of the balance slot, so a later
 * `f.deal` of that token to `account` clears it. Deal first, then blacklist.
 */
export async function blacklist(handle, token, account) {
    const f = handle;
    const blacklister = await roleHolder(f, token, "blacklister", "blacklist");
    await f.prank(blacklister, (c) => c.writeContract({
        address: token,
        abi: fiatTokenAdminAbi,
        functionName: "blacklist",
        args: [account],
    }));
    return blacklister;
}
/** Pause a FiatToken (USDC, EURC): read `pauser()`, prank it, call `pause()`. Resolves to the pauser. */
export async function pause(handle, token) {
    const f = handle;
    const pauser = await roleHolder(f, token, "pauser", "pause");
    await f.prank(pauser, (c) => c.writeContract({ address: token, abi: fiatTokenAdminAbi, functionName: "pause" }));
    return pauser;
}
//# sourceMappingURL=tokens.js.map