/**
 * `@condensate/forkit/bridges`: simulated relayers and solvers for cross-chain tests on a
 * multi-chain fork. `bridge.across(f)`, `bridge.relay(f)`, or `bridge.custom(f, {...})` for any
 * other bridge; then `await b.settle()` fills every pending deposit and `b.fills` lists them.
 */
import { across } from "./across.ts";
import { custom } from "./core.ts";
import { relay } from "./relay.ts";
export { ACROSS_DEFAULT_RELAYER, ACROSS_MULTICALL_HANDLER, ACROSS_SPOKE_POOLS, type AcrossDeposit, type AcrossDepositArgs, type AcrossDepositEvent, type AcrossFeeConfig, type AcrossFill, type AcrossFillDetails, type AcrossOptions, acrossFee, acrossOutputAmount, spokePoolAbi, } from "./across.ts";
export type { BridgeSimulator, CustomBridgeOptions, Deposit, Fill, FillContext, FillResult, MultiFork, } from "./core.ts";
export { DEFAULT_RELAY_SOLVER, type RelayFillDetails, RelayFillError, type RelayOptions, type RelaySimulator, } from "./relay.ts";
export { RELAY_DEPOSITORY, RELAY_NATIVE, RELAY_RECEIVER, RELAY_ROUTER, relayDepositoryAbi, relayReceiverAbi, relayRouterAbi, } from "./relay-contracts.ts";
export { encodeRelayOrderCall, type FillFromQuoteOptions, fillFromQuote, type RelayCall, type RelayDepositArgs, type RelayDepositKind, type RelayFee, type RelayFill, type RelayQuoteLike, } from "./relay-plan.ts";
export { across, custom, relay };
export declare const bridge: {
    readonly across: ((f: import("./core.ts").MultiFork, options?: import("./across.ts").AcrossOptions) => import("./core.ts").BridgeSimulator<import("./across.ts").AcrossDepositArgs>) & {
        outputAmount: typeof import("./across.ts").acrossOutputAmount;
        fee: typeof import("./across.ts").acrossFee;
        spokePools: Readonly<Record<number, `0x${string}`>>;
        defaultRelayer: `0x${string}`;
    };
    readonly relay: ((f: import("./core.ts").MultiFork, options?: import("./relay.ts").RelayOptions) => import("./relay.ts").RelaySimulator) & {
        fillFromQuote: typeof import("./relay-plan.ts").fillFromQuote;
        NATIVE: `0x${string}`;
        DEPOSITORY: `0x${string}`;
        RECEIVER: `0x${string}`;
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
    readonly custom: typeof custom;
};
//# sourceMappingURL=index.d.ts.map