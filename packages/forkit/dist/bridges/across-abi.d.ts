/**
 * The parts of Across's SpokePool ABI the relayer simulator uses, and the SpokePool address table.
 *
 * ABI source: across-protocol/contracts, `contracts/interfaces/V3SpokePoolInterface.sol` and
 * `contracts/spoke-pools/SpokePool.sol`,
 * https://github.com/across-protocol/contracts/blob/master/contracts/interfaces/V3SpokePoolInterface.sol
 * Checked on chain in September 2026 for Ethereum, Optimism, Base and Arbitrum: the recent deposit
 * logs of each SpokePool proxy are all `FundsDeposited` (none `V3FundsDeposited`), and the
 * implementation behind it (the ERC-1967 slot) has both `fillRelay` (selector 0xdeff4b24) and
 * `fillV3Relay` (0x2e378115).
 */
import type { Address } from "viem";
/**
 * Across SpokePool per chain id. Source: Across docs, "Chains & Contracts",
 * https://docs.across.to/reference/contract-addresses (mirrors
 * https://github.com/across-protocol/contracts/blob/master/broadcast/deployed-addresses.json).
 */
export declare const ACROSS_SPOKE_POOLS: Readonly<Record<number, Address>>;
/**
 * Across's MulticallHandler, a message recipient that runs calls and sends leftovers to a fallback
 * recipient. Same address on Ethereum, Optimism, Base, Arbitrum and others. Source: docs.across.to,
 * "Chains & Contracts"; contract: across-protocol/contracts `contracts/handlers/MulticallHandler.sol`.
 */
export declare const ACROSS_MULTICALL_HANDLER: Address;
export declare const spokePoolAbi: readonly [{
    readonly name: "FundsDeposited";
    readonly type: 'event';
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "inputToken";
    }, {
        readonly type: "bytes32";
        readonly name: "outputToken";
    }, {
        readonly type: "uint256";
        readonly name: "inputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "outputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "destinationChainId";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "depositId";
        readonly indexed: true;
    }, {
        readonly type: "uint32";
        readonly name: "quoteTimestamp";
    }, {
        readonly type: "uint32";
        readonly name: "fillDeadline";
    }, {
        readonly type: "uint32";
        readonly name: "exclusivityDeadline";
    }, {
        readonly type: "bytes32";
        readonly name: "depositor";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "recipient";
    }, {
        readonly type: "bytes32";
        readonly name: "exclusiveRelayer";
    }, {
        readonly type: "bytes";
        readonly name: "message";
    }];
}, {
    readonly name: "V3FundsDeposited";
    readonly type: 'event';
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "inputToken";
    }, {
        readonly type: "address";
        readonly name: "outputToken";
    }, {
        readonly type: "uint256";
        readonly name: "inputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "outputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "destinationChainId";
        readonly indexed: true;
    }, {
        readonly type: "uint32";
        readonly name: "depositId";
        readonly indexed: true;
    }, {
        readonly type: "uint32";
        readonly name: "quoteTimestamp";
    }, {
        readonly type: "uint32";
        readonly name: "fillDeadline";
    }, {
        readonly type: "uint32";
        readonly name: "exclusivityDeadline";
    }, {
        readonly type: "address";
        readonly name: "depositor";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "recipient";
    }, {
        readonly type: "address";
        readonly name: "exclusiveRelayer";
    }, {
        readonly type: "bytes";
        readonly name: "message";
    }];
}, {
    readonly name: "fillRelay";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: 'tuple';
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "depositor";
        }, {
            readonly type: "bytes32";
            readonly name: "recipient";
        }, {
            readonly type: "bytes32";
            readonly name: "exclusiveRelayer";
        }, {
            readonly type: "bytes32";
            readonly name: "inputToken";
        }, {
            readonly type: "bytes32";
            readonly name: "outputToken";
        }, {
            readonly type: "uint256";
            readonly name: "inputAmount";
        }, {
            readonly type: "uint256";
            readonly name: "outputAmount";
        }, {
            readonly type: "uint256";
            readonly name: "originChainId";
        }, {
            readonly type: "uint256";
            readonly name: "depositId";
        }, {
            readonly type: "uint32";
            readonly name: "fillDeadline";
        }, {
            readonly type: "uint32";
            readonly name: "exclusivityDeadline";
        }, {
            readonly type: "bytes";
            readonly name: "message";
        }];
        readonly name: "relayData";
    }, {
        readonly type: "uint256";
        readonly name: "repaymentChainId";
    }, {
        readonly type: "bytes32";
        readonly name: "repaymentAddress";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "fillV3Relay";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: 'tuple';
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "depositor";
        }, {
            readonly type: "address";
            readonly name: "recipient";
        }, {
            readonly type: "address";
            readonly name: "exclusiveRelayer";
        }, {
            readonly type: "address";
            readonly name: "inputToken";
        }, {
            readonly type: "address";
            readonly name: "outputToken";
        }, {
            readonly type: "uint256";
            readonly name: "inputAmount";
        }, {
            readonly type: "uint256";
            readonly name: "outputAmount";
        }, {
            readonly type: "uint256";
            readonly name: "originChainId";
        }, {
            readonly type: "uint32";
            readonly name: "depositId";
        }, {
            readonly type: "uint32";
            readonly name: "fillDeadline";
        }, {
            readonly type: "uint32";
            readonly name: "exclusivityDeadline";
        }, {
            readonly type: "bytes";
            readonly name: "message";
        }];
        readonly name: "relayData";
    }, {
        readonly type: "uint256";
        readonly name: "repaymentChainId";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "deposit";
    readonly type: 'function';
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "depositor";
    }, {
        readonly type: "bytes32";
        readonly name: "recipient";
    }, {
        readonly type: "bytes32";
        readonly name: "inputToken";
    }, {
        readonly type: "bytes32";
        readonly name: "outputToken";
    }, {
        readonly type: "uint256";
        readonly name: "inputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "outputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "destinationChainId";
    }, {
        readonly type: "bytes32";
        readonly name: "exclusiveRelayer";
    }, {
        readonly type: "uint32";
        readonly name: "quoteTimestamp";
    }, {
        readonly type: "uint32";
        readonly name: "fillDeadline";
    }, {
        readonly type: "uint32";
        readonly name: "exclusivityParameter";
    }, {
        readonly type: "bytes";
        readonly name: "message";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "depositV3";
    readonly type: 'function';
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "depositor";
    }, {
        readonly type: "address";
        readonly name: "recipient";
    }, {
        readonly type: "address";
        readonly name: "inputToken";
    }, {
        readonly type: "address";
        readonly name: "outputToken";
    }, {
        readonly type: "uint256";
        readonly name: "inputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "outputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "destinationChainId";
    }, {
        readonly type: "address";
        readonly name: "exclusiveRelayer";
    }, {
        readonly type: "uint32";
        readonly name: "quoteTimestamp";
    }, {
        readonly type: "uint32";
        readonly name: "fillDeadline";
    }, {
        readonly type: "uint32";
        readonly name: "exclusivityParameter";
    }, {
        readonly type: "bytes";
        readonly name: "message";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "fillDeadlineBuffer";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint32";
    }];
}, {
    readonly name: "depositQuoteTimeBuffer";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint32";
    }];
}];
/** MulticallHandler's message: `abi.encode(Instructions)` (MulticallHandler.sol). */
export declare const multicallHandlerInstructions: readonly [{
    readonly type: "tuple";
    readonly components: readonly [{
        readonly name: "calls";
        readonly type: "tuple[]";
        readonly components: readonly [{
            readonly name: "target";
            readonly type: "address";
        }, {
            readonly name: "callData";
            readonly type: "bytes";
        }, {
            readonly name: "value";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "fallbackRecipient";
        readonly type: "address";
    }];
}];
//# sourceMappingURL=across-abi.d.ts.map