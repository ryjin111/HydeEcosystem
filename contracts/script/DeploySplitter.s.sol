// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";
import { HydeSplitterFactory } from "../src/HydeFeeSplitter.sol";

/**
 * Deploys the HydeSplitterFactory to Robinhood Chain (4663).
 *
 * Usage (clint's one command, from contracts/):
 *   TREASURY=0x<hydeout-treasury> forge script script/DeploySplitter.s.sol \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com \
 *     --private-key $DEPLOYER_KEY --broadcast
 *
 * HYDE_BPS defaults to 100 (1% of the post-Doppler creator stream).
 */
contract DeploySplitter is Script {
    function run() external {
        address treasury = vm.envAddress("TREASURY");
        uint256 hydeBps = vm.envOr("HYDE_BPS", uint256(100));

        vm.startBroadcast();
        HydeSplitterFactory factory = new HydeSplitterFactory(treasury, hydeBps);
        vm.stopBroadcast();

        console.log("HydeSplitterFactory:", address(factory));
        console.log("  implementation:  ", factory.implementation());
        console.log("  treasury:        ", factory.treasury());
        console.log("  hydeBps:         ", factory.hydeBps());
    }
}
