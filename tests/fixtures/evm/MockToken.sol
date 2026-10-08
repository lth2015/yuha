// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * A mock ERC-20 for local tests. NOT a stablecoin, NOT redeemable, and not a
 * representation of JPYC or USDC — it exists so the payment path can be run
 * against a real EVM instead of a fake node.
 *
 * `decimals` is a constructor argument on purpose. The one thing a mock has to
 * reproduce faithfully here is that eighteen decimals and six decimals are
 * different, because that is where an amount goes wrong by a factor of a
 * trillion and still looks like a number.
 *
 * Deliberately minimal: `transfer` and the Transfer event with indexed from
 * and to, which is the exact shape the scanner decodes. No allowance, no mint
 * authority, no pausing — a mock that grows features grows ways to differ from
 * what it stands in for.
 */
contract MockToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals, uint256 _supply) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        totalSupply = _supply;
        balanceOf[msg.sender] = _supply;
        emit Transfer(address(0), msg.sender, _supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient balance");
        unchecked {
            balanceOf[msg.sender] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(msg.sender, to, value);
        return true;
    }
}
