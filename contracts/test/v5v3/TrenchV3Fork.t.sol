// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {HydeERC20} from "../../src/v3/HydeERC20.sol";
import {TickMath} from "../../src/v3/libraries/TickMath.sol";
import {IUniswapV3Factory} from "../../src/v3/interfaces/IUniswapV3Minimal.sol";
import {TrenchV3Factory} from "../../src/v5v3/TrenchV3Factory.sol";
import {TrenchV3Graduator} from "../../src/v5v3/TrenchV3Graduator.sol";
import {TrenchV3Locker} from "../../src/v5v3/TrenchV3Locker.sol";
import {FlywheelVaultFactory} from "../../src/flywheel/FlywheelVaultFactory.sol";

interface IERC20MetadataV5Fork {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

interface IStablePositionManagerV5Fork {
    function factory() external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IStableV3PoolV5Fork {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @dev Minimal exact-input router used only inside the ephemeral Stable fork.
contract StableV3ForkSwapper {
    using SafeERC20 for IERC20;

    struct CallbackData {
        address pool;
        address token0;
        address token1;
    }

    function swapExactInput(
        address pool,
        address token0,
        address token1,
        address recipient,
        bool zeroForOne,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (int256 amount0, int256 amount1) {
        return IStableV3PoolV5Fork(pool)
            .swap(
                recipient,
                zeroForOne,
                int256(amountIn),
                sqrtPriceLimitX96,
                abi.encode(CallbackData({pool: pool, token0: token0, token1: token1}))
            );
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata rawData) external {
        CallbackData memory data = abi.decode(rawData, (CallbackData));
        require(msg.sender == data.pool, "UNTRUSTED_POOL");
        if (amount0Delta > 0) IERC20(data.token0).safeTransfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(data.token1).safeTransfer(msg.sender, uint256(amount1Delta));
    }
}

/// @notice Live-state release gate for the exact Stable dependencies used by the V5 deployment script.
contract TrenchV3ForkTest is Test {
    uint24 internal constant FEE_TIER = 10_000;
    int24 internal constant TICK_SPACING = 200;
    uint32 internal constant GRADUATION_DELAY = 300;

    address internal constant USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant V3_FACTORY = 0x88F0a512eF09175D456bc9547f914f48C013E4aA;
    address internal constant POSITION_MANAGER = 0x3BdC3437405f7D801b6036532713fc1F179136a6;
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant BUYER = address(0xB0B);
    address internal constant HYDE_TREASURY = address(0x11DE);
    address internal constant LAUNCH_TREASURY = address(0xFEE5);

    bytes32 internal constant USDT0_CODEHASH = 0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e;
    bytes32 internal constant V3_FACTORY_CODEHASH = 0x2616b5c05e19fc8931cdf2f08bf47e05a7db6859c23add2c32d226092409e939;
    bytes32 internal constant POSITION_MANAGER_CODEHASH =
        0x553e7df57c6a17f6d65f05f5c3a3fa41ddaebeca6cf90a0b2b59da3152c41371;

    function testFork_stableDependenciesMatchDeploymentManifest() public {
        string memory rpc = vm.envOr("V5_STABLE_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "V5_STABLE_FORK_RPC not configured");
        }
        vm.createSelectFork(rpc);

        assertEq(block.chainid, 988, "wrong Stable chain");
        assertEq(USDT0.codehash, USDT0_CODEHASH, "USDT0 codehash drift");
        assertEq(V3_FACTORY.codehash, V3_FACTORY_CODEHASH, "V3 factory codehash drift");
        assertEq(POSITION_MANAGER.codehash, POSITION_MANAGER_CODEHASH, "position manager codehash drift");
        assertEq(IERC20MetadataV5Fork(USDT0).decimals(), 6, "USDT0 decimals drift");
        assertEq(
            keccak256(bytes(IERC20MetadataV5Fork(USDT0).symbol())), keccak256(bytes("USDT0")), "USDT0 symbol drift"
        );
        assertEq(IUniswapV3Factory(V3_FACTORY).feeAmountTickSpacing(10_000), 200, "V3 fee tier disabled");
        assertEq(IStablePositionManagerV5Fork(POSITION_MANAGER).factory(), V3_FACTORY, "position manager factory drift");
    }

    function testFork_stableFullLifecycleAgainstLiveDependencies() public {
        string memory rpc = vm.envOr("V5_STABLE_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "V5_STABLE_FORK_RPC not configured");
        }
        vm.createSelectFork(rpc);

        HydeERC20 impl = new HydeERC20();
        TrenchV3Factory factory = new TrenchV3Factory(
            TrenchV3Factory.Config({
                impl: address(impl),
                v3Factory: V3_FACTORY,
                positionManager: POSITION_MANAGER,
                flywheelVaultFactory: address(new FlywheelVaultFactory(address(this))),
                hydeTreasury: HYDE_TREASURY,
                numeraire: USDT0,
                numeraireDecimals: 6,
                feeTier: FEE_TIER,
                startFdvWad: 5_000e18,
                graduationFdvWad: 50_000e18,
                launchFeeAsset: USDT0,
                launchFeeAmount: 1e6,
                launchFeeNative: false,
                launchFeeTreasury: LAUNCH_TREASURY,
                maxWalletBps: 200,
                maxWalletWindowSecs: 300,
                observationCardinality: 512,
                graduationDelay: GRADUATION_DELAY,
                twapTickTolerance: TICK_SPACING,
                minimumProceeds: 12_000e6,
                maxCurveDust: 10e18,
                maxPermanentTokenDust: 10e18,
                maxPermanentQuoteDust: 10,
                owner: address(this)
            })
        );
        TrenchV3Graduator graduator = factory.GRADUATOR();
        TrenchV3Locker locker = factory.LOCKER();

        deal(USDT0, CREATOR, 1e6);
        vm.startPrank(CREATOR);
        IERC20(USDT0).approve(address(factory), 1e6);
        (address token, uint256 curveTokenId) = factory.launch("Trench V5 Fork", "TV5F", bytes32("STABLE_FULL"));
        vm.stopPrank();

        TrenchV3Graduator.Curve memory curve = graduator.curveInfo(token);
        assertEq(IStablePositionManagerV5Fork(POSITION_MANAGER).ownerOf(curveTokenId), address(graduator));
        assertEq(uint8(curve.state), uint8(TrenchV3Graduator.CurveState.CURVE_ACTIVE));
        assertEq(HydeERC20(token).totalSupply(), 1_000_000_000e18);

        // Let the launch-window wallet cap expire, then consume the whole live curve with a real V3 swap.
        vm.warp(block.timestamp + 301);
        StableV3ForkSwapper swapper = new StableV3ForkSwapper();
        uint256 quoteBudget = factory.EXPECTED_TERMINAL_PROCEEDS() * 2;
        deal(USDT0, address(swapper), quoteBudget);
        address token0 = curve.tokenIs0 ? token : USDT0;
        address token1 = curve.tokenIs0 ? USDT0 : token;
        swapper.swapExactInput(
            curve.pool,
            token0,
            token1,
            BUYER,
            !curve.tokenIs0,
            quoteBudget,
            curve.tokenIs0 ? TickMath.getSqrtRatioAtTick(curve.tickUpper) : TickMath.getSqrtRatioAtTick(curve.tickLower)
        );

        TrenchV3Graduator.CurveProgress memory terminal = graduator.curveProgress(token);
        assertEq(terminal.progressWad, 1e18, "live V3 curve did not reach terminal");
        assertGe(terminal.quotePrincipal, 12_000e6);

        graduator.signalGraduation(token);
        vm.warp(block.timestamp + GRADUATION_DELAY + 1);
        uint256[] memory permanentIds = graduator.finalizeGraduation(token, block.timestamp + 1);

        assertGe(permanentIds.length, 1);
        assertLe(permanentIds.length, 3);
        for (uint256 i; i < permanentIds.length; ++i) {
            assertEq(
                IStablePositionManagerV5Fork(POSITION_MANAGER).ownerOf(permanentIds[i]),
                address(locker),
                "permanent NFT not locked"
            );
        }
        vm.expectRevert();
        IStablePositionManagerV5Fork(POSITION_MANAGER).ownerOf(curveTokenId);

        TrenchV3Graduator.Curve memory graduated = graduator.curveInfo(token);
        assertEq(uint8(graduated.state), uint8(TrenchV3Graduator.CurveState.GRADUATED));
        assertEq(HydeERC20(token).balanceOf(address(graduator)), 0);
        assertEq(IERC20(USDT0).balanceOf(address(graduator)), 0);
        assertEq(locker.positionCount(token), permanentIds.length);
    }
}
