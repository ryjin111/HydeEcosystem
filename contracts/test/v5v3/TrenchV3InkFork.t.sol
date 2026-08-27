// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {HydeERC20} from "../../src/v3/HydeERC20.sol";
import {TickMath} from "../../src/v3/libraries/TickMath.sol";
import {TrenchV3Factory} from "../../src/v5v3/TrenchV3Factory.sol";
import {TrenchV3Graduator} from "../../src/v5v3/TrenchV3Graduator.sol";
import {TrenchV3Locker} from "../../src/v5v3/TrenchV3Locker.sol";
import {
    ITrenchSlipstreamFactory,
    ITrenchV3CollectOnly,
    ITrenchV3LockerRegister,
    ITrenchV3PositionManager
} from "../../src/v5v3/interfaces/ITrenchV3.sol";

interface IInkWeth {
    function deposit() external payable;
}

interface IInkPositionManager {
    function factory() external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IInkSlipstreamPool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

contract InkSlipstreamForkSwapper {
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
        return IInkSlipstreamPool(pool)
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

contract TrenchV3InkForkTest is Test {
    uint256 internal constant CHAIN_ID = 57_073;
    uint24 internal constant FEE_TIER = 3_000;
    int24 internal constant TICK_SPACING = 200;
    uint32 internal constant GRADUATION_DELAY = 300;

    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CL_FACTORY = 0x718E46d0962A66942E233760a8bd6038Ce54EdCD;
    address internal constant POSITION_MANAGER = 0xefD0f78F93f578036AE34D52A813a4BE7D8D2D52;
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant BUYER = address(0xB0B);
    address internal constant HYDE_TREASURY = address(0x11DE);
    address internal constant LAUNCH_TREASURY = address(0xFEE5);

    bytes32 internal constant WETH_CODEHASH = 0xd0f1614c5dacfbd34f1c6f500f397009e4c9a8bfd4e02db353edb2253d9a8012;
    bytes32 internal constant FACTORY_CODEHASH = 0x47300e75187cc255355659bf86873d6adfbfe60ad2000e0f6e1274e02917b701;
    bytes32 internal constant POSITION_MANAGER_CODEHASH =
        0x068cdd1c2f2c7c4f78730b56ffe01cace7ef93ca815698cd85c3855ea6b10380;

    function testFork_inkDependenciesMatchPinnedManifest() public {
        if (!_selectInkFork()) return;

        assertEq(block.chainid, CHAIN_ID, "wrong Ink chain");
        assertEq(WETH.codehash, WETH_CODEHASH, "WETH codehash drift");
        assertEq(CL_FACTORY.codehash, FACTORY_CODEHASH, "CL factory codehash drift");
        assertEq(POSITION_MANAGER.codehash, POSITION_MANAGER_CODEHASH, "position manager codehash drift");
        assertEq(ITrenchSlipstreamFactory(CL_FACTORY).tickSpacingToFee(TICK_SPACING), FEE_TIER, "spacing disabled");
        assertEq(IInkPositionManager(POSITION_MANAGER).factory(), CL_FACTORY, "position manager factory drift");
    }

    function testFork_inkFullLifecycleAgainstLiveSlipstream() public {
        if (!_selectInkFork()) return;

        HydeERC20 impl = new HydeERC20();
        uint256 nonce = vm.getNonce(address(this));
        address predictedLocker = vm.computeCreateAddress(address(this), nonce);
        address predictedGraduator = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedFactory = vm.computeCreateAddress(address(this), nonce + 2);
        TrenchV3Locker locker =
            new TrenchV3Locker(ITrenchV3CollectOnly(POSITION_MANAGER), HYDE_TREASURY, predictedGraduator);
        assertEq(address(locker), predictedLocker);
        TrenchV3Graduator graduator = new TrenchV3Graduator(
            TrenchV3Graduator.Config({
                factory: predictedFactory,
                positionManager: ITrenchV3PositionManager(POSITION_MANAGER),
                locker: ITrenchV3LockerRegister(address(locker)),
                numeraire: WETH,
                feeTier: uint24(uint256(int256(TICK_SPACING))),
                tickSpacing: TICK_SPACING,
                slipstream: true,
                graduationDelay: GRADUATION_DELAY,
                twapTickTolerance: TICK_SPACING,
                minimumProceeds: 1 ether,
                maxCurveDust: 10e18,
                maxPermanentTokenDust: 10e18,
                maxPermanentQuoteDust: 1e10
            })
        );
        TrenchV3Factory factory = new TrenchV3Factory(
            TrenchV3Factory.Config({
                impl: address(impl),
                v3Factory: CL_FACTORY,
                positionManager: POSITION_MANAGER,
                locker: address(locker),
                graduator: address(graduator),
                flywheelVaultFactory: address(0),
                hydeTreasury: HYDE_TREASURY,
                numeraire: WETH,
                numeraireDecimals: 18,
                feeTier: FEE_TIER,
                slipstream: true,
                tickSpacing: TICK_SPACING,
                startFdvWad: 1e18,
                graduationFdvWad: 16e18,
                launchFeeAsset: address(0),
                launchFeeAmount: 0.0004 ether,
                launchFeeNative: true,
                launchFeeTreasury: LAUNCH_TREASURY,
                maxWalletBps: 200,
                maxWalletWindowSecs: 300,
                observationCardinality: 512,
                graduationDelay: GRADUATION_DELAY,
                twapTickTolerance: TICK_SPACING,
                minimumProceeds: 1 ether,
                maxCurveDust: 10e18,
                maxPermanentTokenDust: 10e18,
                maxPermanentQuoteDust: 1e10,
                owner: address(this)
            })
        );
        assertEq(address(factory), predictedFactory);

        assertTrue(factory.SLIPSTREAM());
        assertEq(factory.POSITION_KEY(), uint24(uint256(int256(TICK_SPACING))));
        assertEq(address(factory.FLYWHEEL_VAULT_FACTORY()), address(0));
        vm.expectRevert(TrenchV3Factory.InvalidFlywheel.selector);
        factory.launchFlywheel{value: 0.0004 ether}("Disabled Flywheel", "NOFLY", bytes32("NO_FLY"), address(1));

        vm.deal(CREATOR, 1 ether);
        vm.prank(CREATOR);
        (address token, uint256 curveTokenId) =
            factory.launch{value: 0.0004 ether}("Trench V5 Ink Fork", "TV5I", bytes32("INK_FULL"));

        TrenchV3Graduator.Curve memory curve = graduator.curveInfo(token);
        assertEq(
            ITrenchSlipstreamFactory(CL_FACTORY).getPool(token, WETH, TICK_SPACING), curve.pool, "wrong Slipstream pool"
        );
        assertEq(IInkPositionManager(POSITION_MANAGER).ownerOf(curveTokenId), address(graduator));
        assertEq(uint8(curve.state), uint8(TrenchV3Graduator.CurveState.CURVE_ACTIVE));
        assertEq(HydeERC20(token).totalSupply(), 1_000_000_000e18);
        assertGt(factory.EXPECTED_TERMINAL_PROCEEDS(), 1 ether);

        vm.warp(block.timestamp + 301);
        InkSlipstreamForkSwapper swapper = new InkSlipstreamForkSwapper();
        uint256 quoteBudget = factory.EXPECTED_TERMINAL_PROCEEDS() * 2;
        vm.deal(address(swapper), quoteBudget);
        vm.prank(address(swapper));
        IInkWeth(WETH).deposit{value: quoteBudget}();
        address token0 = curve.tokenIs0 ? token : WETH;
        address token1 = curve.tokenIs0 ? WETH : token;
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
        assertEq(terminal.progressWad, 1e18, "live Ink curve did not reach terminal");
        assertGe(terminal.quotePrincipal, 1 ether);

        graduator.signalGraduation(token);
        vm.warp(block.timestamp + GRADUATION_DELAY + 1);
        uint256[] memory permanentIds = graduator.finalizeGraduation(token, block.timestamp + 1);

        assertGe(permanentIds.length, 1);
        assertLe(permanentIds.length, 3);
        for (uint256 i; i < permanentIds.length; ++i) {
            assertEq(IInkPositionManager(POSITION_MANAGER).ownerOf(permanentIds[i]), address(locker));
        }
        vm.expectRevert();
        IInkPositionManager(POSITION_MANAGER).ownerOf(curveTokenId);
        assertEq(uint8(graduator.curveInfo(token).state), uint8(TrenchV3Graduator.CurveState.GRADUATED));
        assertEq(HydeERC20(token).balanceOf(address(graduator)), 0);
        assertEq(IERC20(WETH).balanceOf(address(graduator)), 0);
        assertEq(locker.positionCount(token), permanentIds.length);
    }

    function _selectInkFork() private returns (bool selected) {
        string memory rpc = vm.envOr("V5_INK_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "V5_INK_FORK_RPC not configured");
            return false;
        }
        vm.createSelectFork(rpc);
        return true;
    }
}
