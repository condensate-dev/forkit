/**
 * EIP-2612 `permit`, plus the reads a signer needs: `nonces`, `DOMAIN_SEPARATOR`, `name`,
 * `version` and EIP-5267 `eip712Domain` (the last two are optional on a token). The `bytes
 * signature` overload of `permit` is FiatTokenV2_2's; viem picks an overload by its arguments.
 */
export declare const eip2612Abi: readonly [{
    readonly name: "name";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly name: "version";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly name: "nonces";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "DOMAIN_SEPARATOR";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "eip712Domain";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes1";
        readonly name: "fields";
    }, {
        readonly type: "string";
        readonly name: "name";
    }, {
        readonly type: "string";
        readonly name: "version";
    }, {
        readonly type: "uint256";
        readonly name: "chainId";
    }, {
        readonly type: "address";
        readonly name: "verifyingContract";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }, {
        readonly type: "uint256[]";
        readonly name: "extensions";
    }];
}, {
    readonly name: "permit";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "address";
        readonly name: "spender";
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }, {
        readonly type: "uint256";
        readonly name: "deadline";
    }, {
        readonly type: "uint8";
        readonly name: "v";
    }, {
        readonly type: "bytes32";
        readonly name: "r";
    }, {
        readonly type: "bytes32";
        readonly name: "s";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "permit";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "address";
        readonly name: "spender";
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }, {
        readonly type: "uint256";
        readonly name: "deadline";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}];
/**
 * EIP-3009: the `(v, r, s)` functions from the EIP, FiatTokenV2_2's `bytes signature` overloads,
 * and the events.
 */
export declare const eip3009Abi: readonly [{
    readonly name: "authorizationState";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "authorizer";
    }, {
        readonly type: "bytes32";
        readonly name: "nonce";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "transferWithAuthorization";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }, {
        readonly type: "uint256";
        readonly name: "validAfter";
    }, {
        readonly type: "uint256";
        readonly name: "validBefore";
    }, {
        readonly type: "bytes32";
        readonly name: "nonce";
    }, {
        readonly type: "uint8";
        readonly name: "v";
    }, {
        readonly type: "bytes32";
        readonly name: "r";
    }, {
        readonly type: "bytes32";
        readonly name: "s";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferWithAuthorization";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }, {
        readonly type: "uint256";
        readonly name: "validAfter";
    }, {
        readonly type: "uint256";
        readonly name: "validBefore";
    }, {
        readonly type: "bytes32";
        readonly name: "nonce";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "receiveWithAuthorization";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }, {
        readonly type: "uint256";
        readonly name: "validAfter";
    }, {
        readonly type: "uint256";
        readonly name: "validBefore";
    }, {
        readonly type: "bytes32";
        readonly name: "nonce";
    }, {
        readonly type: "uint8";
        readonly name: "v";
    }, {
        readonly type: "bytes32";
        readonly name: "r";
    }, {
        readonly type: "bytes32";
        readonly name: "s";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "receiveWithAuthorization";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }, {
        readonly type: "uint256";
        readonly name: "validAfter";
    }, {
        readonly type: "uint256";
        readonly name: "validBefore";
    }, {
        readonly type: "bytes32";
        readonly name: "nonce";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "cancelAuthorization";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "authorizer";
    }, {
        readonly type: "bytes32";
        readonly name: "nonce";
    }, {
        readonly type: "uint8";
        readonly name: "v";
    }, {
        readonly type: "bytes32";
        readonly name: "r";
    }, {
        readonly type: "bytes32";
        readonly name: "s";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "cancelAuthorization";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "authorizer";
    }, {
        readonly type: "bytes32";
        readonly name: "nonce";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "AuthorizationUsed";
    readonly type: 'event';
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "authorizer";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "nonce";
        readonly indexed: true;
    }];
}, {
    readonly name: "AuthorizationCanceled";
    readonly type: 'event';
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "authorizer";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "nonce";
        readonly indexed: true;
    }];
}];
/** Circle's FiatToken (USDC, EURC) admin roles: the blacklister and the pauser. */
export declare const fiatTokenAdminAbi: readonly [{
    readonly name: "blacklister";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "isBlacklisted";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "blacklist";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "unBlacklist";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "pauser";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "paused";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "pause";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}, {
    readonly name: "unpause";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}, {
    readonly name: "Blacklisted";
    readonly type: 'event';
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }];
}, {
    readonly name: "UnBlacklisted";
    readonly type: 'event';
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }];
}, {
    readonly name: "Pause";
    readonly type: 'event';
    readonly inputs: readonly [];
}, {
    readonly name: "Unpause";
    readonly type: 'event';
    readonly inputs: readonly [];
}];
/**
 * ERC-20 as USDT on Ethereum implements it: `approve`, `transfer` and `transferFrom` return
 * nothing. viem's `erc20Abi` declares a `bool`, so `simulateContract` (or anything else that
 * decodes the result) fails on USDT with it; this ABI decodes.
 */
export declare const noReturnErc20Abi: readonly [{
    readonly name: "approve";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "spender";
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transfer";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferFrom";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "allowance";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "address";
        readonly name: "spender";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "balanceOf";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}];
/** The single-token parts of Permit2 (SignatureTransfer and AllowanceTransfer), with its events and errors. */
export declare const permit2Abi: readonly [{
    readonly name: "DOMAIN_SEPARATOR";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "nonceBitmap";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "uint256";
        readonly name: "wordPos";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "allowance";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "user";
    }, {
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "address";
        readonly name: "spender";
    }];
    readonly outputs: readonly [{
        readonly type: "uint160";
        readonly name: "amount";
    }, {
        readonly type: "uint48";
        readonly name: "expiration";
    }, {
        readonly type: "uint48";
        readonly name: "nonce";
    }];
}, {
    readonly name: "approve";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "address";
        readonly name: "spender";
    }, {
        readonly type: "uint160";
        readonly name: "amount";
    }, {
        readonly type: "uint48";
        readonly name: "expiration";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "permitTransferFrom";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: 'tuple';
        readonly components: readonly [{
            readonly name: "permitted";
            readonly type: 'tuple';
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "token";
            }, {
                readonly type: "uint256";
                readonly name: "amount";
            }];
        }, {
            readonly type: "uint256";
            readonly name: "nonce";
        }, {
            readonly type: "uint256";
            readonly name: "deadline";
        }];
        readonly name: "permit";
    }, {
        readonly type: 'tuple';
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "to";
        }, {
            readonly type: "uint256";
            readonly name: "requestedAmount";
        }];
        readonly name: "transferDetails";
    }, {
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "permit";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: 'tuple';
        readonly components: readonly [{
            readonly name: "details";
            readonly type: 'tuple';
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "token";
            }, {
                readonly type: "uint160";
                readonly name: "amount";
            }, {
                readonly type: "uint48";
                readonly name: "expiration";
            }, {
                readonly type: "uint48";
                readonly name: "nonce";
            }];
        }, {
            readonly type: "address";
            readonly name: "spender";
        }, {
            readonly type: "uint256";
            readonly name: "sigDeadline";
        }];
        readonly name: "permitSingle";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferFrom";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint160";
        readonly name: "amount";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "invalidateUnorderedNonces";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "wordPos";
    }, {
        readonly type: "uint256";
        readonly name: "mask";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "invalidateNonces";
    readonly type: 'function';
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "address";
        readonly name: "spender";
    }, {
        readonly type: "uint48";
        readonly name: "newNonce";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "Approval";
    readonly type: 'event';
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "spender";
        readonly indexed: true;
    }, {
        readonly type: "uint160";
        readonly name: "amount";
    }, {
        readonly type: "uint48";
        readonly name: "expiration";
    }];
}, {
    readonly name: "Permit";
    readonly type: 'event';
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "spender";
        readonly indexed: true;
    }, {
        readonly type: "uint160";
        readonly name: "amount";
    }, {
        readonly type: "uint48";
        readonly name: "expiration";
    }, {
        readonly type: "uint48";
        readonly name: "nonce";
    }];
}, {
    readonly name: "NonceInvalidation";
    readonly type: 'event';
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "spender";
        readonly indexed: true;
    }, {
        readonly type: "uint48";
        readonly name: "newNonce";
    }, {
        readonly type: "uint48";
        readonly name: "oldNonce";
    }];
}, {
    readonly name: "UnorderedNonceInvalidation";
    readonly type: 'event';
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "word";
    }, {
        readonly type: "uint256";
        readonly name: "mask";
    }];
}, {
    readonly name: "AllowanceExpired";
    readonly type: 'error';
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "deadline";
    }];
}, {
    readonly name: "ExcessiveInvalidation";
    readonly type: 'error';
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientAllowance";
    readonly type: 'error';
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "InvalidAmount";
    readonly type: 'error';
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "maxAmount";
    }];
}, {
    readonly name: "InvalidContractSignature";
    readonly type: 'error';
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidNonce";
    readonly type: 'error';
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignature";
    readonly type: 'error';
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignatureLength";
    readonly type: 'error';
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSigner";
    readonly type: 'error';
    readonly inputs: readonly [];
}, {
    readonly name: "LengthMismatch";
    readonly type: 'error';
    readonly inputs: readonly [];
}, {
    readonly name: "SignatureExpired";
    readonly type: 'error';
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "signatureDeadline";
    }];
}];
//# sourceMappingURL=abi.d.ts.map