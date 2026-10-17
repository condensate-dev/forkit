/**
 * `bridge.relay(f)`: a simulated Relay solver for cross-chain tests on a multi-chain fork.
 *
 * On-chain, a Relay deposit today is a call into the RelayDepository on the origin chain:
 * `depositNative(depositor, id)` or `depositErc20(depositor, token, amount, id)`, emitting
 * `RelayNativeDeposit(from, amount, id)` or `RelayErc20Deposit(from, token, amount, id)`, where the
 * `bytes32 id` is the quote's `protocol.v2.orderId` (https://docs.relay.link/references/protocol/guides/for-apps).
 * The older RelayReceiver (`FundsForwardedWithData(bytes data)`) is still deployed and can be
 * watched with `receiver: true`.
 *
 * What the solver pays on the destination is not in the deposit: it lives in the order
 * (`protocol.v2.orderData.output` of the quote). So a test registers each fill it expects, either by
 * hand (`b.expect(orderId, { destinationChainId, recipient, currency, amount })`) or from a quote
 * response (`b.expectQuote(quote)`). On `settle()`, for each deposit, an impersonated and funded solver
 * pays the recipient on the destination fork (a native transfer or an ERC-20 `transfer`), then runs
 * the order's calls, if any, through Relay's router `multicall`, as Relay's quotes route them.
 * See docs/guides/bridges-relay.md.
 */
import { type Address, type Hex } from "viem";
import { type BridgeSimulator, type MultiFork } from "./core.ts";
import { type FillFromQuoteOptions, fillFromQuote, type RelayDepositArgs, type RelayDepositKind, type RelayFee, type RelayFill, type RelayQuoteLike } from "./relay-plan.ts";
export type { FillFromQuoteOptions, RelayAmountContext, RelayCall, RelayDepositArgs, RelayDepositKind, RelayFee, RelayFill, RelayFillPlan, RelayQuoteLike, } from "./relay-plan.ts";
export { RelayFillError } from "./relay-plan.ts";
/** Where contracts live, per chain id. */
type AddressMap = Readonly<Record<number, Address | readonly Address[]>>;
export interface RelayOptions {
    /** The solver that fills on the destination (impersonated and funded). Default {@link DEFAULT_RELAY_SOLVER}. */
    solver?: Address;
    /** Fee for fills whose output is the default `inputAmount - fee`. Default 0. */
    fee?: RelayFee;
    /** Fills to expect, by order id (or receiver data). Same as calling `b.expect` for each. */
    fills?: Readonly<Record<string, RelayFill>>;
    /** Relay quote responses to expect. Same as calling `b.expectQuote` for each. */
    quotes?: readonly RelayQuoteLike[];
    /**
     * The RelayDepository to watch per origin chain id. Default: Relay's depository on every chain of
     * the fork where its address is known (Ethereum, Optimism, Base, Arbitrum).
     */
    depository?: AddressMap;
    /**
     * Also watch the older RelayReceiver: `true` for its known address on the fork's chains, or a map.
     * Default `false`: Relay's current quotes deposit into the depository.
     */
    receiver?: boolean | AddressMap;
    /** Relay's router per destination chain id, which runs a fill's calls. Merged over the defaults. */
    router?: Readonly<Record<number, Address>>;
}
/** What a Relay fill reports in `Fill.details`. */
export interface RelayFillDetails {
    /** The deposit's order id (or receiver data). */
    orderId: Hex;
    kind: RelayDepositKind;
    solver: Address;
    depositor?: Address;
    inputToken: Address;
    inputAmount?: bigint;
    recipient: Address;
    currency: Address;
    outputAmount: bigint;
    /** Fee taken by the `inputAmount - fee` rule; absent when the fill set its amount. */
    fee?: bigint;
    minimumAmount?: bigint;
    /** How many calls the router ran. */
    calls: number;
    router?: Address;
}
export interface RelaySimulator extends BridgeSimulator<RelayDepositArgs> {
    /** The simulated solver's address on every destination. */
    readonly solver: Address;
    /**
     * Expect a deposit carrying `id` (the quote's `protocol.v2.orderId`; for receiver deposits, the
     * forwarded data) and say how to fill it. Throws if the destination chain is not in the fork.
     */
    expect(id: string, fill: RelayFill): RelaySimulator;
    /** Expect a Relay quote's order: its fill is read from `protocol.v2`. Resolves to the order id. */
    expectQuote(quote: RelayQuoteLike, options?: FillFromQuoteOptions): Hex;
}
/** Default solver: an address derived from a hash, so nothing holds funds there on real chains. */
export declare const DEFAULT_RELAY_SOLVER: Address;
declare function relaySimulator(f: MultiFork, options?: RelayOptions): RelaySimulator;
/**
 * Relay solver simulator. Watches Relay's origin depository on the fork's chains; on `settle()`, a
 * funded, impersonated solver pays each expected fill on its destination and runs its calls.
 *
 * ```ts
 * const b = bridge.relay(f, { fee: 50_000n });
 * b.expect(orderId, { destinationChainId: arbitrum.id, recipient, currency: USDC_ARB });
 * // ... deposit on Base with depositErc20(user, USDC_BASE, amount, orderId)
 * const [fill] = await b.settle(); // recipient got amount - 50_000 USDC on Arbitrum
 * ```
 */
export declare const relay: typeof relaySimulator & {
    /** Read a fill out of a Relay quote response (see {@link fillFromQuote}). */
    fillFromQuote: typeof fillFromQuote;
    /** Native currency in Relay's orders and deposits (the zero address). */
    NATIVE: `0x${string}`;
    /** RelayDepository on Ethereum, Optimism, Base and Arbitrum. */
    DEPOSITORY: `0x${string}`;
    /** RelayReceiver (older deposit target) on the same chains. */
    RECEIVER: `0x${string}`;
    /** RelayRouterV3, which runs a fill's calls, on the same chains. */
    ROUTER: `0x${string}`;
    depositoryAbi: readonly [{
        readonly name: "depositNative";
        readonly type: 'function';
        readonly stateMutability: "payable";
        readonly inputs: readonly [{
            readonly type: "address";
            readonly name: "depositor";
        }, {
            readonly type: "bytes32";
            readonly name: "id";
        }];
        readonly outputs: readonly [];
    }, {
        readonly name: "depositErc20";
        readonly type: 'function';
        readonly stateMutability: "nonpayable";
        readonly inputs: readonly [{
            readonly type: "address";
            readonly name: "depositor";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "uint256";
            readonly name: "amount";
        }, {
            readonly type: "bytes32";
            readonly name: "id";
        }];
        readonly outputs: readonly [];
    }, {
        readonly name: "depositErc20";
        readonly type: 'function';
        readonly stateMutability: "nonpayable";
        readonly inputs: readonly [{
            readonly type: "address";
            readonly name: "depositor";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "id";
        }];
        readonly outputs: readonly [];
    }, {
        readonly name: "RelayNativeDeposit";
        readonly type: 'event';
        readonly inputs: readonly [{
            readonly type: "address";
            readonly name: "from";
        }, {
            readonly type: "uint256";
            readonly name: "amount";
        }, {
            readonly type: "bytes32";
            readonly name: "id";
        }];
    }, {
        readonly name: "RelayErc20Deposit";
        readonly type: 'event';
        readonly inputs: readonly [{
            readonly type: "address";
            readonly name: "from";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "uint256";
            readonly name: "amount";
        }, {
            readonly type: "bytes32";
            readonly name: "id";
        }];
    }];
    receiverAbi: readonly [{
        readonly name: "forward";
        readonly type: 'function';
        readonly stateMutability: "payable";
        readonly inputs: readonly [{
            readonly type: "bytes";
            readonly name: "data";
        }];
        readonly outputs: readonly [];
    }, {
        readonly name: "FundsForwardedWithData";
        readonly type: 'event';
        readonly inputs: readonly [{
            readonly type: "bytes";
            readonly name: "data";
        }];
    }];
};
//# sourceMappingURL=relay.d.ts.map