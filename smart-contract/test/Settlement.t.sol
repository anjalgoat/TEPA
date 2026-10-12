// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TepaToken } from "../src/token/TepaToken.sol";
import { SettlementVault } from "../src/settlement/SettlementVault.sol";
import { TestUsdc } from "../src/mocks/TestUsdc.sol";

contract SettlementHolder {
    function settle(
        SettlementVault vault,
        uint256 index,
        uint256 units,
        uint256 amount,
        bytes32[] calldata proof
    ) external {
        vault.settle(index, units, amount, proof);
    }
}

contract SettlementTest {
    TepaToken token;
    TestUsdc usdc;
    SettlementHolder alice;
    SettlementHolder bob;
    SettlementVault buyback;
    bytes32 constant BUYBACK = keccak256("sample-buyback");
    bytes32 constant ACQUISITION = keccak256("sample-acquisition");

    function root(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return left < right
            ? keccak256(abi.encodePacked(left, right))
            : keccak256(abi.encodePacked(right, left));
    }

    function proof(bytes32 sibling) internal pure returns (bytes32[] memory result) {
        result = new bytes32[](1);
        result[0] = sibling;
    }

    function setUp() public {
        token = new TepaToken(address(this), block.chainid);
        usdc = new TestUsdc();
        alice = new SettlementHolder();
        bob = new SettlementHolder();
        token.grantRole(token.COMPLIANCE_ROLE(), address(this));
        token.grantRole(token.ISSUER_AGENT_ROLE(), address(this));
        token.setEligibility(
            address(alice),
            keccak256("a"),
            keccak256("a-decision"),
            uint64(block.timestamp + 30 days),
            true
        );
        token.setEligibility(
            address(bob),
            keccak256("b"),
            keccak256("b-decision"),
            uint64(block.timestamp + 30 days),
            true
        );
        token.recordAllocation(keccak256("a"), address(alice), 6, keccak256("a-case"));
        token.recordAllocation(keccak256("b"), address(bob), 4, keccak256("b-case"));
        token.mint(keccak256("a"), address(alice), 6, keccak256("a-case"));
        token.mint(keccak256("b"), address(bob), 4, keccak256("b-case"));
        bytes32 a = keccak256(
            abi.encode(
                block.chainid,
                BUYBACK,
                false,
                uint256(0),
                address(alice),
                uint256(2),
                uint256(4_000_000)
            )
        );
        bytes32 b = keccak256(
            abi.encode(
                block.chainid,
                BUYBACK,
                false,
                uint256(1),
                address(bob),
                uint256(1),
                uint256(2_000_000)
            )
        );
        buyback = new SettlementVault(
            address(usdc),
            address(token),
            BUYBACK,
            root(a, b),
            6_000_000,
            3,
            address(this),
            block.chainid,
            false
        );
        token.grantRole(token.BUYBACK_ROLE(), address(buyback));
        usdc.mint(address(this), 13_000_000);
        usdc.approve(address(buyback), 6_000_000);
    }

    function testBuybackPaysAndBurnsOnlyAcceptedUnits() public {
        (bool ok,) = address(buyback).call(abi.encodeCall(SettlementVault.openSettlement, ()));
        require(!ok, "opened without funds");
        buyback.fund(6_000_000);
        buyback.openSettlement();
        bytes32 bobLeaf = buyback.leaf(1, address(bob), 1, 2_000_000);
        (ok,) = address(alice)
            .call(
                abi.encodeCall(SettlementHolder.settle, (buyback, 0, 3, 6_000_000, proof(bobLeaf)))
            );
        require(!ok, "wrong allocation settled");
        alice.settle(buyback, 0, 2, 4_000_000, proof(bobLeaf));
        require(token.balanceOf(address(alice)) == 4, "rejected units burned");
        require(usdc.balanceOf(address(alice)) == 4_000_000, "payment missing");
        (ok,) = address(alice)
            .call(
                abi.encodeCall(SettlementHolder.settle, (buyback, 0, 2, 4_000_000, proof(bobLeaf)))
            );
        require(!ok, "duplicate settlement");
        bytes32 aliceLeaf = buyback.leaf(0, address(alice), 2, 4_000_000);
        bob.settle(buyback, 1, 1, 2_000_000, proof(aliceLeaf));
        require(token.balanceOf(address(bob)) == 3, "wrong remaining balance");
        buyback.finalize();
        require(token.totalSupply() == 7, "wrong supply after buyback");
    }

    function testAcquisitionAfterPartialBuybackClosesSupply() public {
        buyback.fund(6_000_000);
        buyback.openSettlement();
        alice.settle(buyback, 0, 2, 4_000_000, proof(buyback.leaf(1, address(bob), 1, 2_000_000)));
        bob.settle(buyback, 1, 1, 2_000_000, proof(buyback.leaf(0, address(alice), 2, 4_000_000)));
        buyback.finalize();
        bytes32 a = keccak256(
            abi.encode(
                block.chainid,
                ACQUISITION,
                true,
                uint256(0),
                address(alice),
                uint256(4),
                uint256(4_000_000)
            )
        );
        bytes32 b = keccak256(
            abi.encode(
                block.chainid,
                ACQUISITION,
                true,
                uint256(1),
                address(bob),
                uint256(3),
                uint256(3_000_000)
            )
        );
        SettlementVault acquisition = new SettlementVault(
            address(usdc),
            address(token),
            ACQUISITION,
            root(a, b),
            7_000_000,
            7,
            address(this),
            block.chainid,
            true
        );
        token.grantRole(token.SETTLEMENT_ROLE(), address(acquisition));
        usdc.approve(address(acquisition), 7_000_000);
        acquisition.fund(7_000_000);
        acquisition.openSettlement();
        (bool ok,) = address(acquisition).call(abi.encodeCall(SettlementVault.finalize, ()));
        require(!ok, "closed before holder outcomes");
        alice.settle(
            acquisition, 0, 4, 4_000_000, proof(acquisition.leaf(1, address(bob), 3, 3_000_000))
        );
        bob.settle(
            acquisition, 1, 3, 3_000_000, proof(acquisition.leaf(0, address(alice), 4, 4_000_000))
        );
        acquisition.finalize();
        require(token.totalSupply() == 0 && token.terminalSettlement(), "terminal state missing");
        (ok,) = address(token)
            .call(
                abi.encodeCall(
                    TepaToken.mint, (keccak256("a"), address(alice), 6, keccak256("a-case"))
                )
            );
        require(!ok, "post-acquisition mint");
    }

    function testRevokedHolderCannotSettleAndFundsRemain() public {
        buyback.fund(6_000_000);
        buyback.openSettlement();
        token.revokeEligibility(address(alice), keccak256("revoke"));
        (bool ok,) = address(alice)
            .call(
                abi.encodeCall(
                    SettlementHolder.settle,
                    (buyback, 0, 2, 4_000_000, proof(buyback.leaf(1, address(bob), 1, 2_000_000)))
                )
            );
        require(!ok, "revoked holder settled");
        require(
            usdc.balanceOf(address(buyback)) == 6_000_000 && token.balanceOf(address(alice)) == 6,
            "failed settlement changed balances"
        );
    }
}
