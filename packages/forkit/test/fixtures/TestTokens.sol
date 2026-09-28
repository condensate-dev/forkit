// SPDX-License-Identifier: UNLICENSED
// Test fixtures for forkit's deal(). Compiled runtime bytecode lives in tokens.ts;
// regenerate with `forge inspect` (see tokens.ts).
pragma solidity 0.8.30;

/// Plain balance mapping, deliberately not at slot 0.
contract PlainToken {
    string public name = "Plain";
    uint256 public totalSupply;
    address public owner;
    mapping(address => uint256) public balanceOf;
}

/// Balance derived from shares, like a rebasing token: it cannot be dealt by writing storage.
contract SharesToken {
    mapping(address => uint256) public sharesOf;

    function balanceOf(address account) external view returns (uint256) {
        return sharesOf[account] * 2;
    }
}
