// SPDX-License-Identifier: UNLICENSED
// Test fixture for forkit's assertions and traces. Compiled runtime bytecode and ABI live in
// vault.ts; regenerate with `forge inspect` (see vault.ts).
pragma solidity 0.8.30;

/// Holds ether per account and calls into a Ledger, so reverts can come from one call deep.
contract Vault {
    error InsufficientBalance(address account, uint256 have, uint256 want);

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    mapping(address => uint256) public balanceOf;
    Ledger public ledger;

    constructor() {
        ledger = new Ledger();
    }

    function deposit() external payable {
        require(msg.value > 0, "Vault: zero deposit");
        balanceOf[msg.sender] += msg.value;
        ledger.record(msg.sender, msg.value);
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(address payable to, uint256 amount) external {
        uint256 have = balanceOf[msg.sender];
        if (have < amount) revert InsufficientBalance(msg.sender, have, amount);
        balanceOf[msg.sender] = have - amount;
        emit Withdrawn(msg.sender, to, amount);
        to.transfer(amount);
    }

    /// Reverts inside the Ledger with a reason string.
    function audit(uint256 entries) external view returns (uint256) {
        return ledger.check(entries);
    }

    /// Reverts with Panic(0x12), division by zero.
    function ratio(uint256 a, uint256 b) external pure returns (uint256) {
        return a / b;
    }
}

contract Ledger {
    uint256 public total;

    function record(address, uint256 amount) external {
        total += amount;
    }

    function check(uint256 entries) external view returns (uint256) {
        require(entries <= total, "Ledger: not enough entries");
        return total - entries;
    }
}
