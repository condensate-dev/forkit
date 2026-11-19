// SPDX-License-Identifier: UNLICENSED
// Test fixture for bridge.acrossPrefunded. It emits what Across's PrefundedAdapter emits from
// store(), and takes no token. The event and the function signature come from the adapter's
// verified ABI (https://basescan.org/address/0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94#code).
// Compiled runtime bytecode lives in prefunding.ts; regenerate with `forge inspect` (see there).
pragma solidity 0.8.30;

contract PrefundingEmitter {
    event PrefundingStored(bytes32 indexed witness, address token, uint256 amount);

    function store(bytes32 witness, address token, uint256 amount) external payable {
        if (amount > 0) emit PrefundingStored(witness, token, amount);
        if (msg.value > 0) emit PrefundingStored(witness, address(0), msg.value);
    }
}
