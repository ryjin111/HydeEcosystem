// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IStateView} from "v4-periphery/src/interfaces/IStateView.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

import {TrenchV4StackCoordinator} from "../../script/v5v4/DeployTrenchV5V4.s.sol";
import {HydeERC20} from "../../src/HydeERC20.sol";
import {HydeHook} from "../../src/HydeHook.sol";
import {IHydeHook} from "../../src/interfaces/IHydeHook.sol";
import {TrenchV4Factory} from "../../src/v5v4/TrenchV4Factory.sol";
import {TrenchV4Graduator} from "../../src/v5v4/TrenchV4Graduator.sol";
import {TrenchV4Locker} from "../../src/v5v4/TrenchV4Locker.sol";
import {ITrenchV4LockerRegister} from "../../src/v5v4/interfaces/ITrenchV4.sol";

interface IERC20MetadataV5V4Fork {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

interface IWethV5V4Fork is IERC20 {
    function deposit() external payable;
}

interface IPositionManagerV5V4Fork {
    function poolManager() external view returns (address);
}

interface IStateViewV5V4Fork {
    function poolManager() external view returns (address);
}

/// @notice Live-state release gates for the exact Robinhood and Arbitrum V4 dependencies.
contract TrenchV4ForkTest is Test {
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
    );
    int24 internal constant TICK_SPACING = 60;
    uint24 internal constant START_FEE = 30_000;
    uint24 internal constant BASE_FEE = 10_000;
    uint24 internal constant MAX_FEE = 50_000;
    uint32 internal constant ANTI_SNIPE_WINDOW = 300;
    uint16 internal constant ORACLE_CARDINALITY = 2_048;
    uint32 internal constant GRADUATION_DELAY = 300;
    uint256 internal constant LAUNCH_FEE = 0.0004 ether;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant BUYER = address(0xB0B);
    address internal constant HYDE_TREASURY = address(0x11DE);
    address internal constant LAUNCH_TREASURY = address(0xFEE5);

    struct ChainManifest {
        uint256 chainId;
        address poolManager;
        address positionManager;
        address permit2;
        address universalRouter;
        address stateView;
        address weth;
        bytes32 poolManagerHash;
        bytes32 positionManagerHash;
        bytes32 permit2Hash;
        bytes32 universalRouterHash;
        bytes32 stateViewHash;
        bytes32 wethHash;
    }

    struct Stack {
        HydeERC20 impl;
        HydeHook hook;
        TrenchV4Factory factory;
        TrenchV4Graduator graduator;
        TrenchV4Locker locker;
    }

    function testFork_robinhoodDependenciesMatchDeploymentManifest() public {
        string memory rpc = vm.envOr("V5_ROBINHOOD_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "V5_ROBINHOOD_FORK_RPC not configured");
        }
        vm.createSelectFork(rpc);
        _assertManifest(_robinhood());
    }

    function testFork_arbitrumDependenciesMatchDeploymentManifest() public {
        string memory rpc = vm.envOr("V5_ARBITRUM_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "V5_ARBITRUM_FORK_RPC not configured");
        }
        vm.createSelectFork(rpc);
        _assertManifest(_arbitrum());
    }

    function testFork_robinhoodFullLifecycleAgainstLiveDependencies() public {
        string memory rpc = vm.envOr("V5_ROBINHOOD_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "V5_ROBINHOOD_FORK_RPC not configured");
        }
        vm.createSelectFork(rpc);
        ChainManifest memory c = _robinhood();
        _assertManifest(c);
        _assertFullLifecycle(c);
    }

    function testFork_arbitrumFullLifecycleAgainstLiveDependencies() public {
        string memory rpc = vm.envOr("V5_ARBITRUM_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "V5_ARBITRUM_FORK_RPC not configured");
        }
        vm.createSelectFork(rpc);
        ChainManifest memory c = _arbitrum();
        _assertManifest(c);
        _assertFullLifecycle(c);
    }

    function _assertFullLifecycle(ChainManifest memory c) private {
        Stack memory s = _deployStack(c);

        vm.deal(CREATOR, LAUNCH_FEE);
        vm.prank(CREATOR);
        (address token, uint256 curveTokenId) =
            s.factory.launch{value: LAUNCH_FEE}("Trench V5 Fork", "TV5F", bytes32("V4_FULL"));

        TrenchV4Graduator.Curve memory curve = s.graduator.curveInfo(token);
        assertEq(IERC721(c.positionManager).ownerOf(curveTokenId), address(s.graduator));
        assertEq(uint8(curve.state), uint8(TrenchV4Graduator.CurveState.CURVE_ACTIVE));
        assertEq(IERC20(token).totalSupply(), 1_000_000_000e18);

        // Let the launch-wallet cap and anti-snipe fee expire, then execute against the live PoolManager.
        vm.warp(block.timestamp + ANTI_SNIPE_WINDOW + 1);
        PoolSwapTest swapRouter = new PoolSwapTest(IPoolManager(c.poolManager));
        uint256 quoteBudget = s.factory.EXPECTED_TERMINAL_PROCEEDS() * 2;
        vm.deal(BUYER, quoteBudget);
        vm.startPrank(BUYER);
        IWethV5V4Fork(c.weth).deposit{value: quoteBudget}();
        IERC20(c.weth).approve(address(swapRouter), quoteBudget);
        bool wethIs0 = c.weth < token;
        swapRouter.swap(
            _key(token, c.weth, s.hook),
            SwapParams({
                zeroForOne: wethIs0,
                amountSpecified: -int256(quoteBudget),
                sqrtPriceLimitX96: curve.tokenIs0
                    ? TickMath.getSqrtPriceAtTick(curve.tickUpper)
                    : TickMath.getSqrtPriceAtTick(curve.tickLower)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        TrenchV4Graduator.CurveProgress memory terminal = s.graduator.curveProgress(token);
        assertEq(terminal.progressWad, 1e18, "live V4 curve did not reach terminal");
        assertGe(terminal.quotePrincipal, 3e18);

        s.graduator.signalGraduation(token);
        vm.warp(block.timestamp + GRADUATION_DELAY + 1);
        s.graduator.finalizeGraduation(token, block.timestamp + 1);

        TrenchV4Graduator.Curve memory graduated = s.graduator.curveInfo(token);
        assertEq(uint8(graduated.state), uint8(TrenchV4Graduator.CurveState.GRADUATED));
        assertEq(graduated.curveLiquidity, 0);
        vm.expectRevert();
        IERC721(c.positionManager).ownerOf(curveTokenId);

        (address creator, bool opened, bool registered, uint256 count) = s.locker.positionInfo(token);
        assertEq(creator, CREATOR);
        assertTrue(opened);
        assertTrue(registered);
        assertGe(count, 1);
        assertLe(count, 3);
        for (uint256 i; i < count; ++i) {
            assertEq(IERC721(c.positionManager).ownerOf(s.locker.positionIdAt(token, i)), address(s.locker));
        }
        assertEq(IERC20(token).balanceOf(address(s.graduator)), 0);
        assertEq(IERC20(c.weth).balanceOf(address(s.graduator)), 0);
    }

    function _deployStack(ChainManifest memory c) private returns (Stack memory s) {
        address coordinatorAddress = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address implAddress = _child(coordinatorAddress, 1);
        address lockerAddress = _child(coordinatorAddress, 3);
        address graduatorAddress = _child(coordinatorAddress, 4);
        address factoryAddress = _child(coordinatorAddress, 5);

        bytes memory hookArgs = abi.encode(
            IPoolManager(c.poolManager),
            coordinatorAddress,
            c.weth,
            START_FEE,
            BASE_FEE,
            MAX_FEE,
            ANTI_SNIPE_WINDOW,
            ORACLE_CARDINALITY
        );
        (address hookAddress, bytes32 hookSalt) =
            HookMiner.find(coordinatorAddress, HOOK_FLAGS, type(HydeHook).creationCode, hookArgs);

        TrenchV4Factory.Config memory config = TrenchV4Factory.Config({
            impl: implAddress,
            poolManager: IPoolManager(c.poolManager),
            positionManager: IPositionManager(payable(c.positionManager)),
            permit2: IAllowanceTransfer(c.permit2),
            stateView: IStateView(c.stateView),
            hook: IHydeHook(hookAddress),
            locker: TrenchV4Locker(lockerAddress),
            graduator: TrenchV4Graduator(graduatorAddress),
            hydeTreasury: HYDE_TREASURY,
            numeraire: c.weth,
            numeraireDecimals: 18,
            tickSpacing: TICK_SPACING,
            universalRouter: c.universalRouter,
            startFdvWad: 1e18,
            graduationFdvWad: 16e18,
            launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: LAUNCH_TREASURY,
            maxWalletBps: 100,
            maxWalletWindowSecs: 300,
            graduationDelay: GRADUATION_DELAY,
            twapTickTolerance: TICK_SPACING,
            minimumProceeds: 3e18,
            maxCurveDust: 10e18,
            maxPermanentTokenDust: 10e18,
            maxPermanentQuoteDust: 1e12,
            compoundTwapWindow: 300,
            maxCompoundDeviation: 200,
            minCompoundLiquidity: 1e6,
            owner: address(this)
        });

        TrenchV4StackCoordinator.Codes memory codes = TrenchV4StackCoordinator.Codes({
            implCode: type(HydeERC20).creationCode,
            hookCode: abi.encodePacked(type(HydeHook).creationCode, hookArgs),
            hookSalt: hookSalt,
            expectedHook: hookAddress,
            lockerCode: abi.encodePacked(
                type(TrenchV4Locker).creationCode,
                abi.encode(
                    IPositionManager(payable(c.positionManager)),
                    IAllowanceTransfer(c.permit2),
                    IStateView(c.stateView),
                    IHydeHook(hookAddress),
                    c.weth,
                    HYDE_TREASURY,
                    TICK_SPACING,
                    uint32(300),
                    int24(200),
                    uint128(1e6)
                )
            ),
            expectedLocker: lockerAddress,
            graduatorCode: abi.encodePacked(
                type(TrenchV4Graduator).creationCode,
                abi.encode(
                    TrenchV4Graduator.Config({
                        factory: factoryAddress,
                        positionManager: IPositionManager(payable(c.positionManager)),
                        permit2: IAllowanceTransfer(c.permit2),
                        stateView: IStateView(c.stateView),
                        hook: IHydeHook(hookAddress),
                        locker: ITrenchV4LockerRegister(lockerAddress),
                        numeraire: c.weth,
                        tickSpacing: TICK_SPACING,
                        graduationDelay: GRADUATION_DELAY,
                        twapTickTolerance: TICK_SPACING,
                        minimumProceeds: 3e18,
                        maxCurveDust: 10e18,
                        maxPermanentTokenDust: 10e18,
                        maxPermanentQuoteDust: 1e12
                    })
                )
            ),
            expectedGraduator: graduatorAddress,
            factoryCode: abi.encodePacked(type(TrenchV4Factory).creationCode, abi.encode(config)),
            expectedFactory: factoryAddress
        });

        TrenchV4StackCoordinator coordinator = new TrenchV4StackCoordinator(address(this), block.chainid);
        assertEq(address(coordinator), coordinatorAddress);
        coordinator.deploy(codes);

        s = Stack({
            impl: HydeERC20(implAddress),
            hook: HydeHook(hookAddress),
            factory: TrenchV4Factory(factoryAddress),
            graduator: TrenchV4Graduator(graduatorAddress),
            locker: TrenchV4Locker(lockerAddress)
        });
        assertEq(s.hook.factory(), factoryAddress);
        assertEq(address(s.factory.POOL_MANAGER()), c.poolManager);
        assertEq(address(s.factory.POSITION_MANAGER()), c.positionManager);
    }

    function _key(address token, address weth, HydeHook hook) private pure returns (PoolKey memory key) {
        (Currency c0, Currency c1) =
            token < weth ? (Currency.wrap(token), Currency.wrap(weth)) : (Currency.wrap(weth), Currency.wrap(token));
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function _child(address deployer, uint8 nonce) private pure returns (address) {
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(nonce))))));
    }

    function _assertManifest(ChainManifest memory c) private view {
        assertEq(block.chainid, c.chainId, "wrong chain");
        assertEq(c.poolManager.codehash, c.poolManagerHash, "pool manager codehash drift");
        assertEq(c.positionManager.codehash, c.positionManagerHash, "position manager codehash drift");
        assertEq(c.permit2.codehash, c.permit2Hash, "Permit2 codehash drift");
        assertEq(c.universalRouter.codehash, c.universalRouterHash, "universal router codehash drift");
        assertEq(c.stateView.codehash, c.stateViewHash, "StateView codehash drift");
        assertEq(c.weth.codehash, c.wethHash, "WETH codehash drift");
        assertEq(IERC20MetadataV5V4Fork(c.weth).decimals(), 18, "WETH decimals drift");
        assertEq(
            keccak256(bytes(IERC20MetadataV5V4Fork(c.weth).symbol())), keccak256(bytes("WETH")), "WETH symbol drift"
        );
        assertEq(IPositionManagerV5V4Fork(c.positionManager).poolManager(), c.poolManager, "position manager drift");
        assertEq(IStateViewV5V4Fork(c.stateView).poolManager(), c.poolManager, "StateView manager drift");
    }

    function _robinhood() private pure returns (ChainManifest memory c) {
        c = ChainManifest({
            chainId: 4663,
            poolManager: 0x8366a39CC670B4001A1121B8F6A443A643e40951,
            positionManager: 0x58daec3116aae6D93017bAAea7749052E8a04fA7,
            permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3,
            universalRouter: 0x8876789976dEcBfCbBbe364623C63652db8C0904,
            stateView: 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b,
            weth: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,
            poolManagerHash: 0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626,
            positionManagerHash: 0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2,
            permit2Hash: 0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca,
            universalRouterHash: 0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde,
            stateViewHash: 0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6,
            wethHash: 0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353
        });
    }

    function _arbitrum() private pure returns (ChainManifest memory c) {
        c = ChainManifest({
            chainId: 42161,
            poolManager: 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32,
            positionManager: 0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869,
            permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3,
            universalRouter: 0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3,
            stateView: 0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990,
            weth: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1,
            poolManagerHash: 0xe4b2759e456c9c4ef763e3b4e257c5105e1ba283d7de8b131dd321197de794a4,
            positionManagerHash: 0x6156ddaa1c8cd2c26d37455a5dc57b1761dc2848856426c0ac261ae0c7fecd68,
            permit2Hash: 0x9e51dcb64cf56fc09a82cb41edbc17c6a2250f18dbd1b91e884c0aca02acd57c,
            universalRouterHash: 0xc15e8e18812f640245cac34716a18270e3d3288e99b328a410401888ff484720,
            stateViewHash: 0x4c0e823a0cd44b6b2d9485e774c421cf929db3996096d9b84ee6b23525184b9e,
            wethHash: 0x2d240bb4510ed1acfeaba905eb4bcc4524d63c8ae66e48fcccac55ea714db7a7
        });
    }
}
