// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";

/// @notice Live smoke-launch on the deployed testnet own-stack. Launches from a SEPARATE creator wallet
///         (not the deployer) because the deployer is also the fee-treasury in this sandbox — a self-pay
///         would net zero to the treasury. So: deployer funds a creator with gas + the native-ETH fee →
///         creator launches in ONE payable tx (fee rides as msg.value) through the live factory (seeds +
///         MINT_POSITION on the real 46630 PosM).
///   forge script script/LaunchSmoke.s.sol --tc LaunchSmoke --rpc-url $TESTNET_RPC --broadcast
contract LaunchSmoke is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 creatorPk = vm.envUint("CREATOR_PRIVATE_KEY");
        address creator = vm.addr(creatorPk);
        address factory = vm.envAddress("FACTORY");
        string memory name = vm.envOr("LAUNCH_NAME", string("Hyde Testnet One"));
        string memory symbol = vm.envOr("LAUNCH_SYMBOL", string("HYDE1"));
        uint256 fee = 0.0004 ether; // flat native-ETH launch fee

        // 1) deployer funds the creator with gas + the native-ETH fee.
        vm.startBroadcast(deployerPk);
        (bool ok,) = creator.call{value: 0.01 ether}("");
        require(ok, "FUND_FAIL");
        vm.stopBroadcast();

        // 2) creator launches — ONE payable tx, no approval (fee rides as msg.value).
        vm.startBroadcast(creatorPk);
        (address token, uint256 tokenId) = HydeTokenFactory(factory).launch{value: fee}(
            HydeTokenFactory.LaunchParams({name: name, symbol: symbol, presetId: 0})
        );
        vm.stopBroadcast();

        console2.log("== live smoke-launch OK ==");
        console2.log("creator", creator);
        console2.log("token  ", token);
        console2.log("tokenId", tokenId);
    }
}
