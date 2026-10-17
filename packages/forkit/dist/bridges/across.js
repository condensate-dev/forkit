/**
 * `bridge.across(f)`: an Across relayer simulator. It watches each origin fork's SpokePool for
 * deposits and, on `settle()`, fills each one on its destination fork the way an Across relayer
 * does: an impersonated, funded relayer approves the destination SpokePool and calls its fill
 * function with the deposit's relay data. The SpokePool then pays the recipient and runs any
 * message handler for real.
 *
 * Protocol behaviour follows across-protocol/contracts `contracts/spoke-pools/SpokePool.sol`
 * (https://github.com/across-protocol/contracts): `fillRelay` reverts with `NotExclusiveRelayer`
 * while `exclusivityDeadline >= block.timestamp` unless the caller is the exclusive relayer, and
 * with `ExpiredFillDeadline` once `fillDeadline < block.timestamp`; it pulls `outputAmount` of the
 * output token from the caller, sends it to the recipient (unwrapping WETH for EOAs), then calls
 * `handleV3AcrossMessage(token, amount, relayer, message)` on a contract recipient when the
 * message is not empty. See docs/guides/bridges-across.md.
 */
import { erc20Abi, getAbiItem, getAddress, isAddressEqual, keccak256, maxUint256, pad, parseEther, slice, toHex, zeroAddress, } from "viem";
import { ForkitError } from "../errors.js";
import { ACROSS_SPOKE_POOLS, spokePoolAbi } from "./across-abi.js";
import { custom, } from "./core.js";
export { ACROSS_MULTICALL_HANDLER, ACROSS_SPOKE_POOLS, spokePoolAbi } from "./across-abi.js";
/** The default relayer: derived from a hash, so no one holds its key or anything at it. */
export const ACROSS_DEFAULT_RELAYER = getAddress(slice(keccak256(toHex("forkit across relayer")), 12));
/** Native balance the relayer is topped up to when it has less than 1 ether, for gas. */
const RELAYER_GAS = parseEther("10");
/** `outputAmount = inputAmount - fee`, with `fee = inputAmount * bps / 10_000 + fixed`. */
export function acrossOutputAmount(inputAmount, fee = {}) {
    const out = inputAmount - acrossFee(inputAmount, fee);
    if (out < 0n)
        throw new ForkitError(`forkit: the Across fee exceeds the input amount (${inputAmount})`);
    return out;
}
/** The fee `acrossOutputAmount` subtracts: `inputAmount * bps / 10_000 + fixed` (rounded down). */
export function acrossFee(inputAmount, fee = {}) {
    const bps = BigInt(fee.bps ?? 0);
    const fixed = fee.fixed ?? 0n;
    if (bps < 0n || fixed < 0n)
        throw new ForkitError("forkit: an Across fee cannot be negative");
    return (inputAmount * bps) / 10000n + fixed;
}
/** An EVM address from a bytes32 or address field. */
function toAddress(value) {
    return getAddress(value.length === 66 ? slice(value, 12) : value);
}
/** Normalise the decoded args of either deposit event. */
export function decodeAcrossDeposit(event, args) {
    const hex = (name) => args[name];
    const int = (name) => BigInt(args[name]);
    return {
        event,
        depositor: toAddress(hex("depositor")),
        recipient: toAddress(hex("recipient")),
        inputToken: toAddress(hex("inputToken")),
        outputToken: toAddress(hex("outputToken")),
        inputAmount: int("inputAmount"),
        outputAmount: int("outputAmount"),
        destinationChainId: int("destinationChainId"),
        depositId: int("depositId"),
        quoteTimestamp: Number(args.quoteTimestamp),
        fillDeadline: Number(args.fillDeadline),
        exclusivityDeadline: Number(args.exclusivityDeadline),
        exclusiveRelayer: toAddress(hex("exclusiveRelayer")),
        message: hex("message"),
    };
}
/** `V3RelayData` for `fillRelay` (bytes32 addresses). */
export function acrossRelayData(args, originChainId, outputAmount = args.outputAmount) {
    const b32 = (a) => pad(a, { size: 32 });
    return {
        depositor: b32(args.depositor),
        recipient: b32(args.recipient),
        exclusiveRelayer: b32(args.exclusiveRelayer),
        inputToken: b32(args.inputToken),
        outputToken: b32(args.outputToken),
        inputAmount: args.inputAmount,
        outputAmount,
        originChainId: BigInt(originChainId),
        depositId: args.depositId,
        fillDeadline: args.fillDeadline,
        exclusivityDeadline: args.exclusivityDeadline,
        message: args.message,
    };
}
/** `V3RelayDataLegacy` for `fillV3Relay` (addresses, uint32 depositId). */
export function acrossLegacyRelayData(args, originChainId, outputAmount = args.outputAmount) {
    if (args.depositId >= 2n ** 32n)
        throw new ForkitError(`forkit: Across deposit id ${args.depositId} does not fit fillV3Relay's uint32`);
    return {
        depositor: args.depositor,
        recipient: args.recipient,
        exclusiveRelayer: args.exclusiveRelayer,
        inputToken: args.inputToken,
        outputToken: args.outputToken,
        inputAmount: args.inputAmount,
        outputAmount,
        originChainId: BigInt(originChainId),
        depositId: Number(args.depositId),
        fillDeadline: args.fillDeadline,
        exclusivityDeadline: args.exclusivityDeadline,
        message: args.message,
    };
}
/**
 * Who fills: the deposit's exclusive relayer while its window may still be open at `now` (the
 * destination's latest block time; the SpokePool treats `exclusivityDeadline >= block.timestamp`
 * as exclusive, and the exclusive relayer may fill after the window too, so erring towards it is
 * safe), otherwise `fallback`.
 */
export function chooseAcrossRelayer(args, now, fallback) {
    const open = !isAddressEqual(args.exclusiveRelayer, zeroAddress) &&
        BigInt(args.exclusivityDeadline) >= BigInt(now);
    return open
        ? { relayer: args.exclusiveRelayer, exclusive: true }
        : { relayer: fallback, exclusive: false };
}
/** The SpokePool table: the built-in one with the caller's overrides. */
function spokePoolTable(options) {
    return { ...ACROSS_SPOKE_POOLS, ...options.spokePools };
}
/** Origin chain ids to watch, with clear errors for the ones Across cannot serve. */
export function acrossOrigins(forkedChainIds, options = {}) {
    const pools = spokePoolTable(options);
    if (options.origins !== undefined) {
        for (const id of options.origins) {
            if (pools[id] === undefined)
                throw new ForkitError(`forkit: bridge.across has no SpokePool for origin chain ${id}. Pass it with spokePools: { ${id}: "0x…" } (addresses: https://docs.across.to/reference/contract-addresses).`);
        }
        return [...options.origins];
    }
    const origins = forkedChainIds.filter((id) => pools[id] !== undefined);
    if (origins.length === 0)
        throw new ForkitError(`forkit: bridge.across knows no SpokePool on any forked chain (${forkedChainIds.join(", ")}). Pass spokePools: { <chainId>: "0x…" } (addresses: https://docs.across.to/reference/contract-addresses).`);
    return origins;
}
/** Fill one deposit on its destination fork. */
async function fill({ deposit, destination }, options) {
    const args = deposit.args;
    const spokePool = spokePoolTable(options)[deposit.destinationChainId];
    if (spokePool === undefined)
        throw new ForkitError(`forkit: Across deposit ${deposit.id} goes to chain ${deposit.destinationChainId}, which has no known SpokePool. Pass spokePools: { ${deposit.destinationChainId}: "0x…" }.`);
    if (isAddressEqual(args.outputToken, zeroAddress))
        throw new ForkitError(`forkit: Across deposit ${deposit.id} has no output token; the simulator cannot pick one.`);
    const latest = await destination.client.getBlock();
    if (BigInt(args.fillDeadline) < latest.timestamp)
        throw new ForkitError(`forkit: Across deposit ${deposit.id} expired on chain ${deposit.destinationChainId}: its fillDeadline ${args.fillDeadline} is before the destination fork's time ${latest.timestamp}. Pin the forks at nearby times.`);
    const delivered = options.outputAmount?.(deposit) ?? args.outputAmount;
    if (delivered < 0n)
        throw new ForkitError(`forkit: Across outputAmount for ${deposit.id} is negative`);
    const { relayer, exclusive } = chooseAcrossRelayer(args, latest.timestamp, options.relayer ?? ACROSS_DEFAULT_RELAYER);
    const repaymentChainId = typeof options.repaymentChainId === "function"
        ? options.repaymentChainId(deposit)
        : (options.repaymentChainId ?? deposit.destinationChainId);
    await fund(destination, relayer, args.outputToken, delivered);
    const legacy = args.event === "V3FundsDeposited";
    const txHashes = await destination.prank(relayer, async (c) => {
        const hashes = [];
        const allowance = await c.readContract({
            address: args.outputToken,
            abi: erc20Abi,
            functionName: "allowance",
            args: [relayer, spokePool],
        });
        if (allowance < delivered) {
            // Tokens like USDT refuse a non-zero to non-zero approve.
            if (allowance > 0n)
                hashes.push(await c.writeContract({
                    address: args.outputToken,
                    abi: erc20Abi,
                    functionName: "approve",
                    args: [spokePool, 0n],
                }));
            hashes.push(await c.writeContract({
                address: args.outputToken,
                abi: erc20Abi,
                functionName: "approve",
                args: [spokePool, maxUint256],
            }));
        }
        hashes.push(legacy
            ? await c.writeContract({
                address: spokePool,
                abi: spokePoolAbi,
                functionName: "fillV3Relay",
                args: [
                    acrossLegacyRelayData(args, deposit.originChainId, delivered),
                    BigInt(repaymentChainId),
                ],
            })
            : await c.writeContract({
                address: spokePool,
                abi: spokePoolAbi,
                functionName: "fillRelay",
                args: [
                    acrossRelayData(args, deposit.originChainId, delivered),
                    BigInt(repaymentChainId),
                    pad(relayer, { size: 32 }),
                ],
            }));
        return hashes;
    });
    const details = {
        fee: args.inputAmount - delivered,
        depositOutputAmount: args.outputAmount,
        relayer,
        exclusive,
        repaymentChainId,
        spokePool,
        fillFunction: legacy ? "fillV3Relay" : "fillRelay",
    };
    return { txHashes, outputAmount: delivered, details: { ...details } };
}
/** Give `relayer` `amount` more of `token`, and gas money if it is short. */
async function fund(destination, relayer, token, amount) {
    const held = await destination.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [relayer],
    });
    await destination.deal(token, relayer, held + amount);
    const gas = await destination.client.getBalance({ address: relayer });
    if (gas < parseEther("1"))
        await destination.dealNative(relayer, RELAYER_GAS);
}
/** Presents core deposits and fills with normalised args; one view object per deposit or fill. */
class Views {
    #deposits = new WeakMap();
    #fills = new WeakMap();
    deposit(event, d) {
        let v = this.#deposits.get(d);
        if (v === undefined) {
            v = { ...d, address: getAddress(d.address), args: decodeAcrossDeposit(event, d.args) };
            this.#deposits.set(d, v);
        }
        return v;
    }
    fill(event, x) {
        let v = this.#fills.get(x);
        if (v === undefined) {
            v = { ...x, deposit: this.deposit(event, x.deposit) };
            this.#fills.set(x, v);
        }
        return v;
    }
}
/** Merge per-event simulators into one. Deposits of the first part settle first. */
function merge(parts, views) {
    return {
        get pending() {
            return parts.flatMap(({ event, sim }) => sim.pending.map((d) => views.deposit(event, d)));
        },
        get fills() {
            return parts.flatMap(({ event, sim }) => sim.fills.map((x) => views.fill(event, x)));
        },
        async poll() {
            const found = [];
            for (const { event, sim } of parts)
                found.push(...(await sim.poll()).map((d) => views.deposit(event, d)));
            return found;
        },
        async settle() {
            const made = [];
            for (const { event, sim } of parts)
                made.push(...(await sim.settle()).map((x) => views.fill(event, x)));
            return made;
        },
    };
}
function acrossSimulator(f, options = {}) {
    const pools = spokePoolTable(options);
    const origins = acrossOrigins(f.forks.map((m) => m.chain.id), options);
    const address = Object.fromEntries(origins.map((id) => [id, pools[id]]));
    const events = options.events ?? ["FundsDeposited", "V3FundsDeposited"];
    if (events.length === 0)
        throw new ForkitError("forkit: bridge.across needs at least one deposit event");
    const views = new Views();
    return merge(events.map((event) => ({
        event,
        sim: custom(f, {
            name: "across",
            originEvent: { event: getAbiItem({ abi: spokePoolAbi, name: event }), address },
            destinationOf: (args) => args.destinationChainId,
            onDeposit: (context) => fill({ ...context, deposit: views.deposit(event, context.deposit) }, options),
        }),
    })), views);
}
/**
 * Across relayer simulator on a multi-chain fork, e.g. `fork([arbitrum, base])`.
 *
 * ```ts
 * const b = bridge.across(f);
 * // ... deposit into the origin SpokePool ...
 * const [fill] = await b.settle();
 * fill.outputAmount; // delivered to the recipient on the destination fork
 * fill.details?.fee; // inputAmount - delivered
 * ```
 *
 * Helpers: `across.outputAmount(inputAmount, { bps, fixed })` computes a deposit's
 * `outputAmount`, `across.fee(...)` the fee it subtracts, `across.spokePools` is the address table.
 */
export const across = Object.assign(acrossSimulator, {
    outputAmount: acrossOutputAmount,
    fee: acrossFee,
    spokePools: ACROSS_SPOKE_POOLS,
    defaultRelayer: ACROSS_DEFAULT_RELAYER,
});
//# sourceMappingURL=across.js.map