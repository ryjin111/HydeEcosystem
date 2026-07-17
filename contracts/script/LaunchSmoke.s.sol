// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";

/// @notice Live smoke-launch on the deployed testnet own-stack. Launches from a SEPARATE creator wallet
///         (not the deployer) because the deployer is also the fee-treasury in this sandbox — a self-
///         transfer nets zero and trips the factory's exact-received FEE_SHORTFALL guard. So: deployer
///         funds a creator (gas) + mints it mock USDG → creator approves + launches through the live
///         factory (seeds + MINT_POSITION on the real 46630 PosM).
///   forge script script/LaunchSmoke.s.sol --tc LaunchSmoke --rpc-url $TESTNET_RPC --broadcast
contract LaunchSmoke is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 creatorPk = vm.envUint("CREATOR_PRIVATE_KEY");
        address creator = vm.addr(creatorPk);
        address factory = vm.envAddress("FACTORY");
        address usdg = vm.envAddress("USDG");
        string memory name = vm.envOr("LAUNCH_NAME", string("Hyde Testnet One"));
        string memory symbol = vm.envOr("LAUNCH_SYMBOL", string("HYDE1"));
        uint256 fee = 1e6; // $1 in 6-dec USDG

        // 1) deployer funds the creator (gas) + mints it the mock USDG launch fee.
        vm.startBroadcast(deployerPk);
        (bool ok,) = creator.call{value: 0.005 ether}("");
        require(ok, "FUND_FAIL");
        MockERC20(usdg).mint(creator, fee);
        vm.stopBroadcast();

        // 2) creator approves + launches (creator != fee-treasury → exact-received check passes).
        vm.startBroadcast(creatorPk);
        MockERC20(usdg).approve(factory, fee);
        (address token, uint256 tokenId) =
            HydeTokenFactory(factory).launch(HydeTokenFactory.LaunchParams({name: name, symbol: symbol, presetId: 0}));
        vm.stopBroadcast();

        console2.log("== live smoke-launch OK ==");
        console2.log("creator", creator);
        console2.log("token  ", token);
        console2.log("tokenId", tokenId);
    }
}
