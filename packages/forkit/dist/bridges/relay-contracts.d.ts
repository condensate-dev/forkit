/**
 * Relay's on-chain contracts that the simulator touches: addresses and the minimal ABIs.
 *
 * Every fact here comes from Relay's public docs or verified source:
 * - Chain metadata (depository, relayReceiver, erc20Router per chain): Relay's public chains API,
 *   https://api.relay.link/chains, which the docs' address tables are generated from
 *   (https://docs.relay.link/references/protocol/depository/addresses and
 *   https://docs.relay.link/references/api/api_resources/contract-addresses).
 * - RelayDepository: https://docs.relay.link/references/protocol/contracts/evm-depository, source at
 *   https://github.com/relayprotocol/relay-depository (packages/ethereum-vm/src/RelayDepository.sol),
 *   verified as `RelayDepository` at e.g. https://basescan.org/address/0x4cD00E387622C35bDDB9b4c962C136462338BC31
 *   and https://arbiscan.io/address/0x4cD00E387622C35bDDB9b4c962C136462338BC31 (Sourcify exact match).
 * - RelayReceiver: https://github.com/relayprotocol/relay-periphery (src/receiver/RelayReceiver.sol),
 *   verified at https://basescan.org/address/0xa5f565650890fba1824ee0f21ebbbf660a179934 and
 *   https://etherscan.io/address/0xa5f565650890fba1824ee0f21ebbbf660a179934.
 * - RelayRouterV3 (`multicall`): https://github.com/relayprotocol/relay-periphery (src/RelayRouter.sol,
 *   src/common/Multicall3.sol), verified as `RelayRouterV3` at
 *   https://arbiscan.io/address/0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f; listed as the "v3 Router
 *   (Cancun)" in https://docs.relay.link/references/api/api_resources/contract-addresses.
 */
import { type Address } from "viem";
/** Native currency, as Relay's quotes and the depository's `token` args spell it. */
export declare const RELAY_NATIVE: Address;
/**
 * RelayDepository, the live deposit target of Relay quotes (`protocol.v2.paymentDetails.depository`).
 * Same address on Ethereum, Optimism, Base and Arbitrum (api.relay.link/chains, `protocol.v2.depository`).
 */
export declare const RELAY_DEPOSITORY: Address;
/**
 * RelayReceiver, Relay's older deposit target: it forwards `msg.value` to its solver and emits
 * `FundsForwardedWithData(data)`. Still deployed (api.relay.link/chains, `contracts.relayReceiver`), but
 * current quotes deposit into the depository instead, so the simulator watches it only on request.
 */
export declare const RELAY_RECEIVER: Address;
/**
 * RelayRouterV3, the destination contract that runs a fill's calls with itself as `msg.sender`
 * (api.relay.link/chains, `contracts.erc20Router`; also the `extraData` of a quote's order output).
 */
export declare const RELAY_ROUTER: Address;
/** Chains (Ethereum, Optimism, Base, Arbitrum) where the addresses above were checked. */
export declare const RELAY_CHAINS: readonly number[];
/** Relay's chain slugs (`protocol.v2.orderData.output.chainId`) for those chains, from api.relay.link/chains. */
export declare const RELAY_CHAIN_SLUGS: Readonly<Record<string, number>>;
/** Depository events (RelayDepository.sol). Neither indexes its args: `id` is in the log data. */
export declare const relayNativeDepositEvent: {
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
};
export declare const relayErc20DepositEvent: {
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
};
/** RelayReceiver's event: `data` is the forwarded calldata (the request id, for Relay's own quotes). */
export declare const fundsForwardedWithDataEvent: {
    readonly name: "FundsForwardedWithData";
    readonly type: 'event';
    readonly inputs: readonly [{
        readonly type: "bytes";
        readonly name: "data";
    }];
};
/** The depository's deposit functions, for tests and callers that build deposits by hand. */
export declare const relayDepositoryAbi: readonly [{
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
/** RelayReceiver's deposit entry point (it also accepts any calldata through its fallback). */
export declare const relayReceiverAbi: readonly [{
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
/** RelayRouterV3's multicall: each call runs with the router as `msg.sender`. */
export declare const relayRouterAbi: readonly [{
    readonly name: "multicall";
    readonly type: 'function';
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly type: "tuple[]";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "target";
        }, {
            readonly type: "bool";
            readonly name: "allowFailure";
        }, {
            readonly type: "uint256";
            readonly name: "value";
        }, {
            readonly type: "bytes";
            readonly name: "callData";
        }];
        readonly name: "calls";
    }, {
        readonly type: "address";
        readonly name: "refundTo";
    }, {
        readonly type: "address";
        readonly name: "nftRecipient";
    }, {
        readonly type: "bytes";
        readonly name: "metadata";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple[]";
        readonly components: readonly [{
            readonly type: "bool";
            readonly name: "success";
        }, {
            readonly type: "bytes";
            readonly name: "returnData";
        }];
        readonly name: "returnData";
    }];
}];
//# sourceMappingURL=relay-contracts.d.ts.map