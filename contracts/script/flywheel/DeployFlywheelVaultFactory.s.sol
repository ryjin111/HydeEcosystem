// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {FlywheelVaultFactory} from "../../src/flywheel/FlywheelVaultFactory.sol";

/// @notice Deploys the permissionless official FlywheelVault factory with pinned bytecode.
contract DeployFlywheelVaultFactory is Script {
    function run() external returns (FlywheelVaultFactory factory) {
        uint256 expectedChainId = vm.envUint("EXPECTED_CHAIN_ID");
        address expectedDeployer = vm.envAddress("EXPECTED_DEPLOYER");
        address policyOwner = vm.envAddress("FLYWHEEL_POLICY_OWNER");
        address deployer = vm.envOr("SENDER", expectedDeployer);
        require(block.chainid == expectedChainId, "WRONG_CHAIN");
        require(deployer == expectedDeployer, "SENDER_NOT_DEPLOYER");
        require(policyOwner != address(0), "ZERO_POLICY_OWNER");

        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        require(predicted.code.length == 0, "PRE_EXISTING_CODE");

        vm.startBroadcast(deployer);
        factory = new FlywheelVaultFactory(policyOwner);
        vm.stopBroadcast();

        require(address(factory) == predicted && address(factory).code.length != 0, "DEPLOYMENT_DRIFT");
        console2.log("FlywheelVaultFactory", address(factory));
        console2.log("Reward policy owner", policyOwner);
        console2.log("chainId", block.chainid);
    }
}
