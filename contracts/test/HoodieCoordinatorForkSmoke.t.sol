// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateView} from "v4-periphery/src/lens/StateView.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IStateView} from "v4-periphery/src/interfaces/IStateView.sol";

import {HydeERC20} from "../src/HydeERC20.sol";
import {HydeFeeVault} from "../src/HydeFeeVault.sol";
import {HydeFeeCollector} from "../src/HydeFeeCollector.sol";
import {HydeHook} from "../src/HydeHook.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";
import {HoodieLaunchEngine} from "../src/HoodieLaunchEngine.sol";
import {HoodieMetaFactory} from "../src/HoodieMetaFactory.sol";
import {HoodieLauncher} from "../src/HoodieLauncher.sol";
import {IHydeHook} from "../src/interfaces/IHydeHook.sol";
import {IHydeVault} from "../src/interfaces/IHydeVault.sol";
import {HydeDeployConfig} from "../script/DeployHydeStack.s.sol";
import {HoodieStackCoordinator} from "../script/DeployHoodieCoordinator.s.sol";

/// @notice REAL-FORK smoke (Robinhood 4663) for the EIP-3860-safe HOODIE launcher-launcher coordinator: deploys
///         the full stack via `HoodieStackCoordinator` against live V4 core + real $HOODIE, then runs the actual
///         launcher-launcher mechanic (mint a launcher → launch through it) and proves a real HOODIE-paired pool
///         + human creator attribution. Env-gated on `HOODIE_FORK_RPC`; the coordinator's chainid==4663 guard
///         means it only runs on a real 4663 fork. + adversarial finalize-repeat + address-drift rollback.
contract HoodieCoordinatorForkSmoke is Test, HydeDeployConfig {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant HOODIE = 0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3;
    address internal constant HYDE_TREASURY = 0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3;
    address internal constant LAUNCH_TREASURY = 0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3;
    address internal constant OWNER = 0x800557e7882b42ee49594fa2790300A9697a0e4D;

    address internal alice = makeAddr("alice");
    HydeHook internal hydeHook;
    bool internal enabled;

    event PositionRegistered(address indexed token, address indexed creator, uint256 tokenId);

    function setUp() public {
        string memory rpc = vm.envOr("HOODIE_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        enabled = true;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663, "not a 4663 fork");
    }

    function test_fork_hoodieCoordinator_deploy_and_launcherLaunch() public {
        if (!enabled) return;

        HoodieStackCoordinator coord = new HoodieStackCoordinator(OWNER);
        (HoodieStackCoordinator.Codes memory c, address hookAddr) = _codesFor(coord);
        vm.prank(OWNER);
        (address engine, address meta) = coord.deploy(c);

        // wiring
        assertEq(HydeTokenFactory(engine).WETH(), HOODIE, "engine base != HOODIE");
        assertEq(HoodieLaunchEngine(engine).META_FACTORY(), meta, "engine META_FACTORY");
        assertEq(HoodieMetaFactory(meta).ENGINE(), engine, "meta ENGINE");
        hydeHook = HydeHook(hookAddr);

        // one-shot finalize
        vm.prank(OWNER);
        vm.expectRevert(bytes("FINALIZED"));
        coord.deploy(c);

        // THE launcher-launcher mechanic: alice mints her own launcher → launches through it.
        vm.prank(alice);
        HoodieLauncher launcher = HoodieLauncher(HoodieMetaFactory(meta).createLauncher(bytes32("smoke")));
        assertTrue(HoodieLaunchEngine(engine).isLauncher(address(launcher)), "launcher not registered");

        address predicted = HoodieLaunchEngine(engine).predictNextFor(address(launcher), alice, "SMK");
        address collector = HydeTokenFactory(engine).COLLECTOR();
        vm.expectEmit(true, true, false, false, collector); // collector records the HUMAN creator (90%-routing)
        emit PositionRegistered(predicted, alice, 0);

        vm.deal(alice, LAUNCH_FEE);
        vm.prank(alice);
        (address token, uint256 tokenId) = launcher.launch{value: LAUNCH_FEE}("Smoke", "SMK", 0);
        assertEq(token, predicted, "predicted != deployed");

        // real HOODIE-paired pool on live V4
        PoolKey memory key = _hoodieKey(token);
        (uint160 sqrtPriceX96,,,) = StateView(STATE_VIEW).getSlot0(key.toId());
        assertTrue(sqrtPriceX96 != 0, "pool not initialized at HOODIE pair on real 4663");
        assertEq(IERC721(POSITION_MANAGER).ownerOf(tokenId), HydeTokenFactory(engine).COLLECTOR(), "position not custody-locked");
        console2.log("HOODIE launcher-launcher OK on real 4663 via coordinator:", token);
    }

    /// @notice Adversarial: tampered `expectedMeta` → META_ADDR revert + atomic rollback.
    function test_fork_hoodie_addressDrift_reverts_and_rolls_back() public {
        if (!enabled) return;
        HoodieStackCoordinator coord = new HoodieStackCoordinator(OWNER);
        (HoodieStackCoordinator.Codes memory c,) = _codesFor(coord);
        c.expectedMeta = address(0xBAD);
        vm.prank(OWNER);
        vm.expectRevert(bytes("META_ADDR"));
        coord.deploy(c);
        assertFalse(coord.finalized(), "finalized must roll back");
        assertEq(coord.engine(), address(0), "engine must roll back");
    }

    function _codesFor(HoodieStackCoordinator coord) internal view returns (HoodieStackCoordinator.Codes memory c, address hookAddr) {
        address implA = _child(address(coord), 1);
        address vaultA = _child(address(coord), 2);
        address collectorA = _child(address(coord), 3);
        address launcherA = _child(address(coord), 5);
        address engineA = _child(address(coord), 6);
        address metaA = _child(address(coord), 7);
        bytes memory hookArgs =
            abi.encode(IPoolManager(POOL_MANAGER), vaultA, HOODIE, START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY);
        bytes32 hookSalt;
        (hookAddr, hookSalt) = HookMiner.find(address(coord), HOOK_FLAGS, type(HydeHook).creationCode, hookArgs);
        c.implCode = type(HydeERC20).creationCode;
        c.vaultCode = abi.encodePacked(
            type(HydeFeeVault).creationCode,
            abi.encode(IERC20(HOODIE), collectorA, IPoolManager(POOL_MANAGER), IHydeHook(hookAddr), TICK_SPACING, HYDE_TREASURY, HYDE_BPS, NET_BPS, MAX_SLIPPAGE, TWAP_WINDOW, MAX_SETTLE_DEV_TICKS)
        );
        c.collectorCode = abi.encodePacked(
            type(HydeFeeCollector).creationCode,
            abi.encode(IPositionManager(payable(POSITION_MANAGER)), IPoolManager(POOL_MANAGER), IHydeVault(vaultA), HOODIE, IHydeHook(hookAddr), IAllowanceTransfer(PERMIT2), IStateView(STATE_VIEW), TICK_SPACING, LIQ_BPS, NET_BPS, MIN_ADD_LIQUIDITY, MAX_ADD_DEV_TICKS, TWAP_WINDOW)
        );
        c.hookCode = abi.encodePacked(type(HydeHook).creationCode, hookArgs);
        c.hookSalt = hookSalt;
        c.launcherImplCode = type(HoodieLauncher).creationCode;
        c.engineCode = abi.encodePacked(type(HoodieLaunchEngine).creationCode, abi.encode(_factoryParams(implA, vaultA, collectorA, hookAddr), _presets(), metaA));
        c.metaFactoryCode = abi.encodePacked(type(HoodieMetaFactory).creationCode, abi.encode(engineA, launcherA));
        c.expectedHook = hookAddr;
        c.expectedEngine = engineA;
        c.expectedMeta = metaA;
    }

    function _factoryParams(address implA, address vaultA, address collectorA, address hookAddr)
        internal
        view
        returns (HydeTokenFactory.ConstructorParams memory p)
    {
        p = HydeTokenFactory.ConstructorParams({
            impl: implA, collector: collectorA, vault: vaultA, hook: hookAddr, poolManager: POOL_MANAGER,
            positionManager: POSITION_MANAGER, permit2: PERMIT2, launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: LAUNCH_TREASURY, weth: HOODIE, universalRouter: UNIVERSAL_ROUTER, tickSpacing: TICK_SPACING,
            maxSeedDust: MAX_SEED_DUST, maxWalletBps: MAX_WALLET_BPS, maxWalletWindowSecs: MAX_WALLET_WINDOW,
            graduationThreshold: GRAD_THRESHOLD, owner: OWNER
        });
    }

    function _presets() internal pure returns (HydeTokenFactory.PresetInput[] memory presets) {
        presets = new HydeTokenFactory.PresetInput[](1);
        presets[0] = HydeTokenFactory.PresetInput({
            initialTick0: C0_INIT, tickLower0: C0_LOWER, tickUpper0: C0_UPPER,
            initialTick1: C1_INIT, tickLower1: C1_LOWER, tickUpper1: C1_UPPER
        });
    }

    function _hoodieKey(address token) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = token < HOODIE
            ? (Currency.wrap(token), Currency.wrap(HOODIE))
            : (Currency.wrap(HOODIE), Currency.wrap(token));
        return PoolKey({currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: TICK_SPACING, hooks: IHooks(address(hydeHook))});
    }

    function _child(address coord, uint8 n) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), coord, bytes1(n))))));
    }
}
