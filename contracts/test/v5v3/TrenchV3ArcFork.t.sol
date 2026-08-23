// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {HydeERC20} from "../../src/v3/HydeERC20.sol";
import {IUniswapV3Factory} from "../../src/v3/interfaces/IUniswapV3Minimal.sol";
import {TickMath} from "../../src/v3/libraries/TickMath.sol";
import {TrenchV3Factory} from "../../src/v5v3/TrenchV3Factory.sol";
import {TrenchV3Graduator} from "../../src/v5v3/TrenchV3Graduator.sol";
import {TrenchV3Locker} from "../../src/v5v3/TrenchV3Locker.sol";
import {FlywheelVaultFactory} from "../../src/flywheel/FlywheelVaultFactory.sol";

interface IERC20MetadataArcFork {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

interface IArcPositionManagerFork {
    function factory() external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IArcV3PoolFork {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @dev Foundry does not implement Arc's native-USDC transfer precompile. The lifecycle fork etches
///      this standard ERC-20 facade at Arc's USDC address while retaining the live V3 contracts.
contract ArcForkUsdc {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract ArcV3ForkSwapper {
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
        return IArcV3PoolFork(pool)
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

contract TrenchV3ArcForkTest is Test {
    uint24 internal constant FEE_TIER = 10_000;
    int24 internal constant TICK_SPACING = 200;
    uint32 internal constant GRADUATION_DELAY = 300;

    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant V3_FACTORY = 0xf0db7b58379503491d857dB50AC9ece64c653918;
    address internal constant POSITION_MANAGER = 0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377;
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant BUYER = address(0xB0B);
    address internal constant HYDE_TREASURY = address(0x11DE);
    address internal constant LAUNCH_TREASURY = address(0xFEE5);

    bytes32 internal constant USDC_CODEHASH = 0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d;
    bytes32 internal constant V3_FACTORY_CODEHASH = 0x621c4819f7b62d7ddb153206bc30950bcc3f5cc9d24c45661f8c2f31dcbd166d;
    bytes32 internal constant POSITION_MANAGER_CODEHASH =
        0xcad0552151ba7675afe512ebe77fcc6eed68a0cb65775d31e38d44823e6796a0;

    function testFork_arcDependenciesMatchDeploymentManifest() public {
        string memory rpc = vm.envOr("V5_ARC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "V5_ARC_FORK_RPC not configured");
        }
        vm.createSelectFork(rpc);

        assertEq(block.chainid, 5_042, "wrong Arc chain");
        assertEq(USDC.codehash, USDC_CODEHASH, "USDC codehash drift");
        assertEq(V3_FACTORY.codehash, V3_FACTORY_CODEHASH, "V3 factory codehash drift");
        assertEq(POSITION_MANAGER.codehash, POSITION_MANAGER_CODEHASH, "position manager codehash drift");
        assertEq(IERC20MetadataArcFork(USDC).decimals(), 6, "USDC decimals drift");
        assertEq(keccak256(bytes(IERC20MetadataArcFork(USDC).symbol())), keccak256(bytes("USDC")), "USDC symbol drift");
        assertEq(IUniswapV3Factory(V3_FACTORY).feeAmountTickSpacing(FEE_TIER), TICK_SPACING, "V3 fee tier disabled");
        assertEq(IArcPositionManagerFork(POSITION_MANAGER).factory(), V3_FACTORY, "position manager factory drift");
    }

    function testFork_arcFullLifecycleAgainstLiveDependencies() public {
        string memory rpc = vm.envOr("V5_ARC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "V5_ARC_FORK_RPC not configured");
        }
        vm.createSelectFork(rpc);

        // The manifest test validates live native-USDC code. Foundry cannot execute Arc's custom
        // 0xef native-transfer precompile, so replace only the ERC-20 facade for stateful lifecycle
        // execution. Factory, pool, PositionManager, and Hydeout contracts stay real.
        ArcForkUsdc usdcTemplate = new ArcForkUsdc();
        vm.etch(USDC, address(usdcTemplate).code);

        HydeERC20 impl = new HydeERC20();
        TrenchV3Factory factory = new TrenchV3Factory(
            TrenchV3Factory.Config({
                impl: address(impl),
                v3Factory: V3_FACTORY,
                positionManager: POSITION_MANAGER,
                flywheelVaultFactory: address(new FlywheelVaultFactory(address(this))),
                hydeTreasury: HYDE_TREASURY,
                numeraire: USDC,
                numeraireDecimals: 6,
                feeTier: FEE_TIER,
                startFdvWad: 5_000e18,
                graduationFdvWad: 50_000e18,
                launchFeeAsset: USDC,
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

        ArcForkUsdc(USDC).mint(CREATOR, 1e6);
        vm.startPrank(CREATOR);
        IERC20(USDC).approve(address(factory), 1e6);
        (address token, uint256 curveTokenId) = factory.launch("Trench V5 Arc Fork", "TV5A", bytes32("ARC_FULL"));
        vm.stopPrank();

        TrenchV3Graduator.Curve memory curve = graduator.curveInfo(token);
        assertEq(IArcPositionManagerFork(POSITION_MANAGER).ownerOf(curveTokenId), address(graduator));
        assertEq(uint8(curve.state), uint8(TrenchV3Graduator.CurveState.CURVE_ACTIVE));
        assertEq(HydeERC20(token).totalSupply(), 1_000_000_000e18);

        vm.warp(block.timestamp + 301);
        ArcV3ForkSwapper swapper = new ArcV3ForkSwapper();
        uint256 quoteBudget = factory.EXPECTED_TERMINAL_PROCEEDS() * 2;
        ArcForkUsdc(USDC).mint(address(swapper), quoteBudget);
        address token0 = curve.tokenIs0 ? token : USDC;
        address token1 = curve.tokenIs0 ? USDC : token;
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
        assertEq(terminal.progressWad, 1e18, "live Arc V3 curve did not reach terminal");
        assertGe(terminal.quotePrincipal, 12_000e6);

        graduator.signalGraduation(token);
        vm.warp(block.timestamp + GRADUATION_DELAY + 1);
        uint256[] memory permanentIds = graduator.finalizeGraduation(token, block.timestamp + 1);

        assertGe(permanentIds.length, 1);
        assertLe(permanentIds.length, 3);
        for (uint256 i; i < permanentIds.length; ++i) {
            assertEq(
                IArcPositionManagerFork(POSITION_MANAGER).ownerOf(permanentIds[i]),
                address(locker),
                "permanent NFT not locked"
            );
        }
        vm.expectRevert();
        IArcPositionManagerFork(POSITION_MANAGER).ownerOf(curveTokenId);

        TrenchV3Graduator.Curve memory graduated = graduator.curveInfo(token);
        assertEq(uint8(graduated.state), uint8(TrenchV3Graduator.CurveState.GRADUATED));
        assertEq(HydeERC20(token).balanceOf(address(graduator)), 0);
        assertEq(IERC20(USDC).balanceOf(address(graduator)), 0);
        assertEq(locker.positionCount(token), permanentIds.length);
    }
}
