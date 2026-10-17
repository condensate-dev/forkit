/**
 * The pure half of the Relay simulator: decoding deposits, reading fills out of Relay quotes, and
 * planning a fill (amounts, fees, calls). No RPC here, so all of it is unit-tested offline.
 *
 * Sources: Relay's docs on the order and its two ids
 * (https://docs.relay.link/references/protocol/guides/for-apps), quote validation
 * (https://docs.relay.link/references/api/api_core_concepts/input-validation), and the verified
 * contracts cited in relay-contracts.ts.
 */
import { decodeAbiParameters, encodeAbiParameters, getAddress, isHex, parseAbiParameters, size, } from "viem";
import { ForkitError } from "../errors.js";
import { RELAY_CHAIN_SLUGS, RELAY_NATIVE } from "./relay-contracts.js";
/** A Relay fill that cannot be planned or performed: unknown order, bad amounts, missing router. */
export class RelayFillError extends ForkitError {
    name = "RelayFillError";
}
/** A deposit or order id as a lower-case hex key. */
export function relayKey(id) {
    if (!isHex(id, { strict: true }) || id.length <= 2) {
        throw new RelayFillError(`forkit: Relay id ${JSON.stringify(id)} is not hex data`);
    }
    return id.toLowerCase();
}
/** Normalize the decoded args of one of Relay's deposit events. */
export function decodeRelayDeposit(kind, args, txValue) {
    switch (kind) {
        case "native":
            return {
                kind,
                id: relayKey(args.id),
                from: getAddress(args.from),
                token: RELAY_NATIVE,
                amount: args.amount,
            };
        case "erc20":
            return {
                kind,
                id: relayKey(args.id),
                from: getAddress(args.from),
                token: getAddress(args.token),
                amount: args.amount,
            };
        case "receiver":
            return {
                kind,
                id: relayKey(args.data),
                token: RELAY_NATIVE,
                ...(txValue === undefined ? {} : { amount: txValue }),
            };
    }
}
function feeOf(fee, input) {
    if (typeof fee === "bigint")
        return fee;
    return (input * BigInt(fee.bps)) / 10000n + (fee.fixed ?? 0n);
}
/**
 * Resolve a registered fill against its deposit: the output amount (exact, custom, or
 * `inputAmount - fee`), the slippage floor, and the calls with their router.
 */
export function planRelayFill(deposit, fill, defaults = {}) {
    const where = `Relay order ${deposit.id}`;
    let outputAmount;
    let fee;
    if (typeof fill.amount === "bigint") {
        outputAmount = fill.amount;
    }
    else if (typeof fill.amount === "function") {
        outputAmount = fill.amount({ deposit, inputAmount: deposit.amount });
    }
    else {
        if (deposit.amount === undefined) {
            throw new RelayFillError(`forkit: ${where}: the deposited amount is unknown (a receiver deposit made through another contract), so the output cannot be inputAmount - fee. Set \`amount\` on the fill.`);
        }
        fee = feeOf(fill.fee ?? defaults.fee ?? 0n, deposit.amount);
        if (fee < 0n || fee > deposit.amount) {
            throw new RelayFillError(`forkit: ${where}: fee ${fee} is outside the deposited amount ${deposit.amount}`);
        }
        outputAmount = deposit.amount - fee;
    }
    if (outputAmount < 0n) {
        throw new RelayFillError(`forkit: ${where}: output amount ${outputAmount} is negative`);
    }
    if (fill.minimumAmount !== undefined && outputAmount < fill.minimumAmount) {
        throw new RelayFillError(`forkit: ${where}: output ${outputAmount} is below the order's minimumAmount ${fill.minimumAmount} (slippage too high); a solver would not fill it`);
    }
    const calls = [...(fill.calls ?? [])];
    const router = fill.router ?? defaults.router;
    if (calls.length > 0 && router === undefined) {
        throw new RelayFillError(`forkit: ${where} has calls but no known Relay router on chain ${fill.destinationChainId}; pass \`router\` on the fill or in the simulator options`);
    }
    return {
        recipient: getAddress(fill.recipient),
        currency: getAddress(fill.currency),
        outputAmount,
        ...(fee === undefined ? {} : { fee }),
        ...(fill.minimumAmount === undefined ? {} : { minimumAmount: fill.minimumAmount }),
        calls,
        ...(calls.length > 0 && router !== undefined ? { router: getAddress(router) } : {}),
        refundTo: getAddress(fill.refundTo ?? deposit.from ?? fill.recipient),
    };
}
/**
 * Each entry of `orderData.output.calls` is `abi.encode((address to), (bytes data), (uint256 value))`:
 * three one-field tuples, as Relay's settlement SDK encodes them (`encodeOrderCall` in
 * https://github.com/relayprotocol/relay-settlement, packages/sdk/src/order/index.ts).
 */
const ORDER_CALL_PARAMS = parseAbiParameters(["(address to)", "(bytes data)", "(uint256 value)"]);
/** `orderData.output.extraData`: `abi.encode((address fillContract))`, the contract that runs the fill. */
const ORDER_EXTRA_DATA_PARAMS = parseAbiParameters(["(address fillContract)"]);
/** Decode one entry of `orderData.output.calls`. */
export function decodeRelayOrderCall(encoded) {
    const [{ to }, { data }, { value }] = decodeAbiParameters(ORDER_CALL_PARAMS, encoded);
    return { to, data, value };
}
/** Encode a call the way Relay orders carry it (for tests and hand-built quotes). */
export function encodeRelayOrderCall(call) {
    return encodeAbiParameters(ORDER_CALL_PARAMS, [
        { to: call.to },
        { data: call.data },
        { value: call.value ?? 0n },
    ]);
}
/**
 * Read a fill out of a Relay quote's `protocol.v2` order: the one payment (recipient, currency,
 * expected and minimum amounts), the calls and the router. Returns the ids to register it under:
 * the order id (what the depository deposit carries) and the request id, if present.
 */
export function fillFromQuote(quote, options = {}) {
    const v2 = quote.protocol?.v2;
    const output = v2?.orderData?.output;
    if (v2 === undefined || output === undefined) {
        throw new RelayFillError("forkit: this Relay quote has no protocol.v2 order (orderId and orderData.output), so its fill is unknown; register it with b.expect(id, fill)");
    }
    const payments = output.payments ?? [];
    const payment = payments[0];
    if (payment === undefined || payments.length !== 1) {
        throw new RelayFillError(`forkit: Relay order ${v2.orderId} has ${payments.length} output payments; the simulator reads exactly one from a quote (register other shapes with b.expect)`);
    }
    const slug = output.chainId;
    const destinationChainId = quote.details?.currencyOut?.currency?.chainId ??
        (slug === undefined ? undefined : RELAY_CHAIN_SLUGS[slug]);
    if (destinationChainId === undefined) {
        throw new RelayFillError(`forkit: cannot tell the destination chain id of Relay order ${v2.orderId} (chain "${slug}"); register it with b.expect(id, fill)`);
    }
    const pick = options.amount ?? "expected";
    const amount = pick === "expected" ? payment.expectedAmount : payment.minimumAmount;
    if (amount === undefined) {
        throw new RelayFillError(`forkit: Relay order ${v2.orderId} has no ${pick}Amount`);
    }
    const calls = (output.calls ?? []).map((c) => decodeRelayOrderCall(relayKey(c)));
    const extra = output.extraData;
    const router = extra !== undefined && isHex(extra) && size(extra) === 32
        ? decodeAbiParameters(ORDER_EXTRA_DATA_PARAMS, extra)[0].fillContract
        : undefined;
    const fill = {
        destinationChainId,
        recipient: getAddress(payment.recipient),
        currency: getAddress(payment.currency),
        amount: BigInt(amount),
        ...(payment.minimumAmount === undefined
            ? {}
            : { minimumAmount: BigInt(payment.minimumAmount) }),
        ...(calls.length > 0 ? { calls } : {}),
        ...(router === undefined ? {} : { router }),
    };
    const requestId = quote.requestId ?? quote.steps?.find((s) => s.requestId)?.requestId;
    const ids = [relayKey(v2.orderId)];
    if (requestId !== undefined && relayKey(requestId) !== ids[0])
        ids.push(relayKey(requestId));
    return { ids, fill };
}
//# sourceMappingURL=relay-plan.js.map