// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TepaToken } from "../../src/token/TepaToken.sol";

interface VmDeploy {
    function envUint(string calldata name) external returns (uint256);
    function envAddress(string calldata name) external returns (address);
    function addr(uint256 privateKey) external returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployTepa {
    VmDeploy constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (TepaToken token) {
        uint256 chainId = vm.envUint("EXPECTED_CHAIN_ID");
        require(
            chainId == block.chainid && (chainId == 31337 || chainId == 84532), "wrong demo chain"
        );
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address compliance = vm.envAddress("COMPLIANCE_SIGNER_ADDRESS");
        address issuerAgent = vm.envAddress("ISSUER_SIGNER_ADDRESS");
        address pauser = vm.envAddress("PAUSER_SIGNER_ADDRESS");
        address recovery = vm.envAddress("RECOVERY_SIGNER_ADDRESS");
        address finalAdmin = vm.envAddress("DEMO_ADMIN_ADDRESS");
        vm.startBroadcast(privateKey);
        token = new TepaToken(deployer, chainId);
        token.grantRole(token.COMPLIANCE_ROLE(), compliance);
        token.grantRole(token.ISSUER_AGENT_ROLE(), issuerAgent);
        token.grantRole(token.PAUSER_ROLE(), pauser);
        token.grantRole(token.RECOVERY_ROLE(), recovery);
        if (finalAdmin != deployer) {
            token.grantRole(token.DEFAULT_ADMIN_ROLE(), finalAdmin);
            token.revokeRole(token.DEFAULT_ADMIN_ROLE(), deployer);
        }
        vm.stopBroadcast();
    }
}
