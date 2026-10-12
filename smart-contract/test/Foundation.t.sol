// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract FoundationProbe {
    uint256 public value;

    function set(uint256 nextValue) external {
        require(nextValue <= 1_000, "sample bound");
        value = nextValue;
    }
}

contract FoundationTest {
    function testLocalDeploymentAndStateChange() public {
        FoundationProbe probe = new FoundationProbe();
        probe.set(1_000);
        require(probe.value() == 1_000, "state change failed");
    }

    function testRejectedValueDoesNotChangeState() public {
        FoundationProbe probe = new FoundationProbe();
        (bool success,) = address(probe).call(abi.encodeCall(FoundationProbe.set, (1_001)));
        require(!success, "out-of-range write accepted");
        require(probe.value() == 0, "rejected write changed state");
    }
}
