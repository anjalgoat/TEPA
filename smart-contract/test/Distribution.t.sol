// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TepaToken } from "../src/token/TepaToken.sol";
import { DistributionVault } from "../src/distribution/DistributionVault.sol";
import { TestUsdc } from "../src/mocks/TestUsdc.sol";

interface VmDistribution {
    function warp(uint256) external;
}

contract ClaimActor {
    function claim(DistributionVault vault, uint256 index, uint256 amount, bytes32[] calldata proof)
        external
    {
        vault.claim(index, amount, proof);
    }

    function fund(DistributionVault vault, uint256 amount) external {
        vault.fund(amount);
    }

    function open(DistributionVault vault) external {
        vault.openClaims();
    }
}

contract FalseAsset {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

contract DistributionTest {
    VmDistribution constant vm =
        VmDistribution(address(uint160(uint256(keccak256("hevm cheat code")))));
    TepaToken token;
    TestUsdc usdc;
    DistributionVault vault;
    ClaimActor alice;
    ClaimActor bob;
    bytes32 constant EPOCH = keccak256("synthetic-2025-q1");
    uint256 constant ALICE_AMOUNT = 6_000_000;
    uint256 constant BOB_AMOUNT = 4_000_000;

    function setUp() public {
        token = new TepaToken(address(this), block.chainid);
        token.grantRole(token.COMPLIANCE_ROLE(), address(this));
        token.grantRole(token.PAUSER_ROLE(), address(this));
        usdc = new TestUsdc();
        alice = new ClaimActor();
        bob = new ClaimActor();
        token.setEligibility(
            address(alice),
            keccak256("a"),
            keccak256("decision-a"),
            uint64(block.timestamp + 1 days),
            true
        );
        token.setEligibility(
            address(bob),
            keccak256("b"),
            keccak256("decision-b"),
            uint64(block.timestamp + 1 days),
            true
        );
        bytes32 a =
            keccak256(abi.encode(block.chainid, EPOCH, uint256(0), address(alice), ALICE_AMOUNT));
        bytes32 b =
            keccak256(abi.encode(block.chainid, EPOCH, uint256(1), address(bob), BOB_AMOUNT));
        bytes32 root = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        vault = new DistributionVault(
            address(usdc), address(token), EPOCH, root, 10_000_000, address(this), block.chainid
        );
        usdc.mint(address(this), 10_000_000);
        usdc.approve(address(vault), 10_000_000);
    }

    function testFundingProofAndOneTimeClaims() public {
        (bool ok,) = address(vault).call(abi.encodeCall(DistributionVault.openClaims, ()));
        require(!ok, "opened before funding");
        vault.fund(9_000_000);
        (ok,) = address(vault).call(abi.encodeCall(DistributionVault.openClaims, ()));
        require(!ok, "opened underfunded");
        vault.fund(1_000_000);
        vault.openClaims();
        bytes32[] memory aProof = new bytes32[](1);
        aProof[0] = vault.leaf(1, address(bob), BOB_AMOUNT);
        (ok,) = address(alice)
            .call(abi.encodeCall(ClaimActor.claim, (vault, 0, ALICE_AMOUNT + 1, aProof)));
        require(!ok, "wrong amount accepted");
        alice.claim(vault, 0, ALICE_AMOUNT, aProof);
        require(usdc.balanceOf(address(alice)) == ALICE_AMOUNT);
        (ok,) =
            address(alice).call(abi.encodeCall(ClaimActor.claim, (vault, 0, ALICE_AMOUNT, aProof)));
        require(!ok, "duplicate accepted");
        bytes32[] memory bProof = new bytes32[](1);
        bProof[0] = vault.leaf(0, address(alice), ALICE_AMOUNT);
        bob.claim(vault, 1, BOB_AMOUNT, bProof);
        require(vault.claimedAmount() == vault.committedAmount());
    }

    function testRevokedAndWrongWalletCannotClaim() public {
        vault.fund(10_000_000);
        vault.openClaims();
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = vault.leaf(1, address(bob), BOB_AMOUNT);
        token.revokeEligibility(address(alice), keccak256("revoked"));
        (bool ok,) =
            address(alice).call(abi.encodeCall(ClaimActor.claim, (vault, 0, ALICE_AMOUNT, proof)));
        require(!ok, "revoked claimed");
        (ok,) = address(bob).call(abi.encodeCall(ClaimActor.claim, (vault, 0, ALICE_AMOUNT, proof)));
        require(!ok, "wrong wallet claimed");
        require(usdc.balanceOf(address(vault)) == 10_000_000);
    }

    function testTokenPausePreservesClaimAndExpiryBlocksIt() public {
        vault.fund(10_000_000);
        vault.openClaims();
        bytes32[] memory aProof = new bytes32[](1);
        aProof[0] = vault.leaf(1, address(bob), BOB_AMOUNT);
        token.pause();
        alice.claim(vault, 0, ALICE_AMOUNT, aProof);
        require(usdc.balanceOf(address(alice)) == ALICE_AMOUNT, "pause stranded claim");
        bytes32[] memory bProof = new bytes32[](1);
        bProof[0] = vault.leaf(0, address(alice), ALICE_AMOUNT);
        vm.warp(block.timestamp + 2 days);
        (bool ok,) =
            address(bob).call(abi.encodeCall(ClaimActor.claim, (vault, 1, BOB_AMOUNT, bProof)));
        require(!ok, "expired eligibility claimed");
        require(usdc.balanceOf(address(vault)) == BOB_AMOUNT, "blocked amount moved");
    }

    function testUnauthorizedOperatorAndFalseAssetReject() public {
        (bool ok,) = address(alice).call(abi.encodeCall(ClaimActor.fund, (vault, 1_000_000)));
        require(!ok, "unauthorized funding passed");
        (ok,) = address(alice).call(abi.encodeCall(ClaimActor.open, (vault)));
        require(!ok, "unauthorized opening passed");
        FalseAsset bad = new FalseAsset();
        DistributionVault badVault = new DistributionVault(
            address(bad),
            address(token),
            EPOCH,
            vault.entitlementRoot(),
            10_000_000,
            address(this),
            block.chainid
        );
        (ok,) = address(badVault).call(abi.encodeCall(DistributionVault.fund, (10_000_000)));
        require(!ok, "false-returning asset funded");
        require(badVault.fundedAmount() == 0, "failed funding changed state");
    }
}
