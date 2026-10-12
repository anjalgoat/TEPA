// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TepaToken } from "../src/token/TepaToken.sol";

interface Vm {
    function warp(uint256) external;
    function chainId(uint256) external;
}

contract HolderProbe {
    function transfer(TepaToken token, address to, uint256 units) external returns (bool) {
        return token.transfer(to, units);
    }

    function transferFrom(TepaToken token, address from, address to, uint256 units)
        external
        returns (bool)
    {
        return token.transferFrom(from, to, units);
    }
}

contract IssuanceTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant A = keccak256("synthetic-holder-a");
    bytes32 constant B = keccak256("synthetic-holder-b");
    bytes32 constant C = keccak256("case-a");
    TepaToken token;
    HolderProbe alice;
    HolderProbe bob;

    function setUp() public {
        vm.chainId(31337);
        token = new TepaToken(address(this), 31337);
        alice = new HolderProbe();
        bob = new HolderProbe();
        token.grantRole(token.COMPLIANCE_ROLE(), address(this));
        token.grantRole(token.ISSUER_AGENT_ROLE(), address(this));
        token.grantRole(token.RECOVERY_ROLE(), address(this));
        token.grantRole(token.PAUSER_ROLE(), address(this));
    }

    function approveBoth() internal {
        token.setEligibility(
            address(alice), A, keccak256("decision-a"), uint64(block.timestamp + 1 days), true
        );
        token.setEligibility(
            address(bob), B, keccak256("decision-b"), uint64(block.timestamp + 1 days), true
        );
    }

    function testRecordedAllocationAndDirectTransferRejection() public {
        approveBoth();
        token.recordAllocation(A, address(alice), 600, C);
        token.recordAllocation(B, address(bob), 400, keccak256("case-b"));
        token.mint(A, address(alice), 600, C);
        token.mint(B, address(bob), 400, keccak256("case-b"));
        require(token.totalSupply() == 1_000 && token.balanceOf(address(alice)) == 600);
        require(!token.canTransfer(address(alice), address(bob), 1));
        (bool ok,) =
            address(alice).call(abi.encodeCall(HolderProbe.transfer, (token, address(bob), 1)));
        require(!ok, "direct transfer passed");
        (ok,) = address(bob)
            .call(
                abi.encodeCall(HolderProbe.transferFrom, (token, address(alice), address(bob), 1))
            );
        require(!ok, "delegated transfer passed");
        (ok,) = address(token).call(abi.encodeCall(TepaToken.mint, (A, address(alice), 600, C)));
        require(!ok, "duplicate mint passed");
    }

    function testUnapprovedExpiredRevokedFrozenAndWrongChainReject() public {
        (bool ok,) = address(token)
            .call(abi.encodeCall(TepaToken.recordAllocation, (A, address(alice), uint16(600), C)));
        require(!ok, "unapproved allocation passed");
        approveBoth();
        token.recordAllocation(A, address(alice), 600, C);
        token.revokeEligibility(address(alice), keccak256("revoked"));
        (ok,) = address(token)
            .call(abi.encodeCall(TepaToken.mint, (A, address(alice), uint16(600), C)));
        require(!ok, "revoked mint passed");
        token.setEligibility(
            address(alice), A, keccak256("decision-2"), uint64(block.timestamp + 1), true
        );
        vm.warp(block.timestamp + 2);
        (ok,) = address(token)
            .call(abi.encodeCall(TepaToken.mint, (A, address(alice), uint16(600), C)));
        require(!ok, "expired mint passed");
        token.setEligibility(
            address(alice), A, keccak256("decision-3"), uint64(block.timestamp + 1 days), true
        );
        token.setAddressFrozen(address(alice), true);
        (ok,) = address(token)
            .call(abi.encodeCall(TepaToken.mint, (A, address(alice), uint16(600), C)));
        require(!ok, "frozen mint passed");
        token.setAddressFrozen(address(alice), false);
        vm.chainId(84532);
        (ok,) = address(token)
            .call(abi.encodeCall(TepaToken.mint, (A, address(alice), uint16(600), C)));
        require(!ok, "wrong-chain mint passed");
    }

    function testWrongAmountAndUnauthorizedMintReject() public {
        approveBoth();
        token.recordAllocation(A, address(alice), 600, C);
        (bool ok,) =
            address(token).call(abi.encodeCall(TepaToken.mint, (A, address(alice), uint16(601), C)));
        require(!ok, "wrong amount passed");
        (ok,) = address(alice).call(abi.encodeCall(HolderProbe.transfer, (token, address(bob), 1)));
        require(!ok);
        token.pause();
        (ok,) = address(token)
            .call(abi.encodeCall(TepaToken.mint, (A, address(alice), uint16(600), C)));
        require(!ok, "paused mint passed");
    }

    function testRecoveryRequiresSameSubjectAndCaseCannotReplay() public {
        approveBoth();
        token.recordAllocation(A, address(alice), 600, C);
        token.mint(A, address(alice), 600, C);
        (bool ok,) = address(token)
            .call(
                abi.encodeCall(
                    TepaToken.recoveryAddress, (address(alice), address(bob), keccak256("recovery"))
                )
            );
        require(!ok, "different subject recovery passed");
        HolderProbe replacement = new HolderProbe();
        token.setEligibility(
            address(replacement), A, keccak256("new-wallet"), uint64(block.timestamp + 1 days), true
        );
        token.recoveryAddress(address(alice), address(replacement), keccak256("recovery"));
        require(
            token.balanceOf(address(alice)) == 0 && token.balanceOf(address(replacement)) == 600
        );
        require(!token.isVerified(address(alice)));
        (ok,) = address(token)
            .call(
                abi.encodeCall(
                    TepaToken.recoveryAddress,
                    (address(alice), address(replacement), keccak256("recovery"))
                )
            );
        require(!ok, "replayed recovery passed");
    }
}
