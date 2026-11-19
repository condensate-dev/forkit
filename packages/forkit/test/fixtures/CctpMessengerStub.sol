// SPDX-License-Identifier: UNLICENSED
// Test fixture for bridge.cctp. On the origin it emits the two DepositForBurn events of Circle's
// TokenMessenger (v1) and TokenMessengerV2, and burns nothing. On the destination it answers the
// two reads the simulator makes: localMinter() is itself, and getLocalToken() is the token stored
// with setLocalToken(). Event fields come from https://github.com/circlefin/evm-cctp-contracts
// (src/TokenMessenger.sol, src/v2/TokenMessengerV2.sol). Bytecode lives in cctp.ts.
pragma solidity 0.8.30;

contract CctpMessengerStub {
    event DepositForBurn(
        uint64 indexed nonce,
        address indexed burnToken,
        uint256 amount,
        address indexed depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        bytes32 destinationTokenMessenger,
        bytes32 destinationCaller
    );
    event DepositForBurn(
        address indexed burnToken,
        uint256 amount,
        address indexed depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        bytes32 destinationTokenMessenger,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 indexed minFinalityThreshold,
        bytes hookData
    );

    address public localToken;

    function setLocalToken(address token) external {
        localToken = token;
    }

    function localMinter() external view returns (address) {
        return address(this);
    }

    function getLocalToken(uint32, bytes32) external view returns (address) {
        return localToken;
    }

    function burnV1(
        uint64 nonce,
        address burnToken,
        uint256 amount,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        bytes32 destinationTokenMessenger
    ) external {
        emit DepositForBurn(
            nonce, burnToken, amount, msg.sender, mintRecipient, destinationDomain, destinationTokenMessenger, bytes32(0)
        );
    }

    function burnV2(
        address burnToken,
        uint256 amount,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        bytes32 destinationTokenMessenger,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        emit DepositForBurn(
            burnToken,
            amount,
            msg.sender,
            mintRecipient,
            destinationDomain,
            destinationTokenMessenger,
            bytes32(0),
            maxFee,
            minFinalityThreshold,
            hookData
        );
    }
}
