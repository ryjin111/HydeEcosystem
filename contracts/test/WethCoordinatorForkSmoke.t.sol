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
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IStateView} from "v4-periphery/src/interfaces/IStateView.sol";

import {HydeERC20} from "../src/HydeERC20.sol";
import {HydeFeeVault} from "../src/HydeFeeVault.sol";
import {HydeFeeCollector} from "../src/HydeFeeCollector.sol";
import {HydeHook} from "../src/HydeHook.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";
import {IHydeHook} from "../src/interfaces/IHydeHook.sol";
import {IHydeVault} from "../src/interfaces/IHydeVault.sol";
import {HydeDeployConfig} from "../script/DeployHydeStack.s.sol";
import {HydeStackCoordinator} from "../script/DeployWethStack4663.s.sol";

/// @notice REAL-FORK smoke (Robinhood 4663) for the EIP-3860-safe WETH coordinator (kami §B): deploys the WETH
///         launchpad through `HydeStackCoordinator` (calldata-initcode CREATE/CREATE2) against the LIVE 4663 V4
///         core + real WETH, asserts wiring, then does a **live launch** through the deployed factory and proves
///         a WETH-paired pool was created. Env-gated on `WETH_FORK_RPC` → no-op skip offline (plain `forge test`
///         stays green; the coordinator's `chainid==4663` guard means it can ONLY run on a real 4663 fork).
///           WETH_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/WethCoordinatorForkSmoke.t.sol -vv
contract WethCoordinatorForkSmoke is Test, HydeDeployConfig {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant HYDE_TREASURY = 0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3;
    address internal constant LAUNCH_TREASURY = 0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3;
    address internal constant OWNER = 0x800557e7882b42ee49594fa2790300A9697a0e4D;

    address internal alice = makeAddr("alice");
    HydeHook internal hydeHook;
    bool internal enabled;

    function setUp() public {
        string memory rpc = vm.envOr("WETH_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        enabled = true;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663, "not a 4663 fork");
    }

    function test_fork_wethCoordinator_deploy_and_launch() public {
        if (!enabled) return;

        // 1) Deploy the coordinator (this test contract is the deploying EOA + OWNER).
        HydeStackCoordinator coord = new HydeStackCoordinator(OWNER);

        // 2-3) Predict children + mine hook + build the child initcodes (shared helper).
        (HydeStackCoordinator.Codes memory c,) = _codesFor(coord);

        // 4) Deploy the stack through the coordinator (OWNER-gated) + assert wiring.
        vm.prank(OWNER);
        (address vault, address collector, address hook, address factory) = coord.deploy(c);
        assertEq(HydeTokenFactory(factory).WETH(), WETH, "factory base != WETH");
        assertEq(HydeFeeVault(vault).factory(), factory, "vault factory");
        assertEq(HydeFeeCollector(collector).factory(), factory, "collector factory");
        assertEq(HydeHook(hook).factory(), factory, "hook factory");
        hydeHook = HydeHook(hook);

        // 4b) One-shot finalize — a repeat deploy MUST revert (no re-run / re-wire).
        vm.prank(OWNER);
        vm.expectRevert(bytes("FINALIZED"));
        coord.deploy(c);

        // 5) LIVE LAUNCH through the freshly-deployed factory on real 4663 infra.
        uint256 treBefore = LAUNCH_TREASURY.balance; // real on-chain balance — assert the DELTA
        vm.deal(alice, LAUNCH_FEE);
        vm.prank(alice);
        (address token, uint256 tokenId) =
            HydeTokenFactory(factory).launch{value: LAUNCH_FEE}(HydeTokenFactory.LaunchParams({name: "WethSmoke", symbol: "WSMK", presetId: 0}));
        assertTrue(token != address(0), "no token");
        tokenId; // (custody tokenId unused in this smoke)

        // 6) Prove the launched pool exists on real V4 and is WETH-paired (spot price set at the sorted key).
        PoolKey memory key = _wethKey(token);
        (uint160 sqrtPriceX96,,,) = StateView(STATE_VIEW).getSlot0(key.toId());
        assertTrue(sqrtPriceX96 != 0, "pool not initialized at WETH pair on real 4663");
        assertEq(LAUNCH_TREASURY.balance - treBefore, LAUNCH_FEE, "flat launch fee to treasury");
        console2.log("WETH-paired launch OK on real 4663 via coordinator:", token);
    }

    /// @notice Adversarial: a tampered `expectedFactory` must revert AND roll back atomically (no partial
    ///         stack, coordinator left un-finalized). Exercises drift-detection + all-or-nothing on real infra.
    function test_fork_addressDrift_reverts_and_rolls_back() public {
        if (!enabled) return;
        HydeStackCoordinator coord = new HydeStackCoordinator(OWNER);
        (HydeStackCoordinator.Codes memory c,) = _codesFor(coord);
        c.expectedFactory = address(0xBAD); // drift the final assert
        vm.prank(OWNER);
        vm.expectRevert(bytes("FACTORY_ADDR"));
        coord.deploy(c);
        // atomic rollback: the reverted deploy left NO state.
        assertFalse(coord.finalized(), "finalized must roll back");
        assertEq(coord.impl(), address(0), "impl must roll back");
        assertEq(coord.factory(), address(0), "factory must roll back");
    }

    /// @notice Adversarial (salt-drift, kami 23587): tamper `hookSalt` but KEEP the original `expectedHook` →
    ///         the CREATE2 lands elsewhere (or reverts on invalid hook-bits) → HOOK_ADDR/CREATE2_FAIL + atomic
    ///         rollback. Distinct from the factory-address-drift case.
    function test_fork_saltDrift_reverts_and_rolls_back() public {
        if (!enabled) return;
        HydeStackCoordinator coord = new HydeStackCoordinator(OWNER);
        (HydeStackCoordinator.Codes memory c,) = _codesFor(coord);
        c.hookSalt = bytes32(uint256(c.hookSalt) ^ 1); // flip a bit; original expectedHook retained
        vm.prank(OWNER);
        vm.expectRevert(); // HOOK_ADDR (mined elsewhere) OR CREATE2_FAIL (bad hook-bits ctor revert)
        coord.deploy(c);
        assertFalse(coord.finalized(), "finalized must roll back");
        assertEq(coord.impl(), address(0), "impl must roll back");
        assertEq(coord.hook(), address(0), "hook must roll back");
    }

    /// @dev Predict children + mine hook + build the 4 child initcodes for `coord` (mirrors the script).
    function _codesFor(HydeStackCoordinator coord) internal view returns (HydeStackCoordinator.Codes memory c, address hookAddr) {
        address implA = _child(address(coord), 1);
        address vaultA = _child(address(coord), 2);
        address collectorA = _child(address(coord), 3);
        bytes memory hookArgs =
            abi.encode(IPoolManager(POOL_MANAGER), vaultA, WETH, START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY);
        bytes32 hookSalt;
        (hookAddr, hookSalt) = HookMiner.find(address(coord), HOOK_FLAGS, type(HydeHook).creationCode, hookArgs);
        c.implCode = type(HydeERC20).creationCode;
        c.vaultCode = abi.encodePacked(
            type(HydeFeeVault).creationCode,
            abi.encode(IERC20(WETH), collectorA, IPoolManager(POOL_MANAGER), IHydeHook(hookAddr), TICK_SPACING, HYDE_TREASURY, HYDE_BPS, NET_BPS, MAX_SLIPPAGE, TWAP_WINDOW, MAX_SETTLE_DEV_TICKS)
        );
        c.collectorCode = abi.encodePacked(
            type(HydeFeeCollector).creationCode,
            abi.encode(IPositionManager(payable(POSITION_MANAGER)), IPoolManager(POOL_MANAGER), IHydeVault(vaultA), WETH, IHydeHook(hookAddr), IAllowanceTransfer(PERMIT2), IStateView(STATE_VIEW), TICK_SPACING, LIQ_BPS, NET_BPS, MIN_ADD_LIQUIDITY, MAX_ADD_DEV_TICKS, TWAP_WINDOW)
        );
        c.hookCode = abi.encodePacked(type(HydeHook).creationCode, hookArgs);
        c.hookSalt = hookSalt;
        c.factoryCode = abi.encodePacked(type(HydeTokenFactory).creationCode, abi.encode(_factoryParams(implA, vaultA, collectorA, hookAddr), _presets()));
        c.expectedHook = hookAddr;
        c.expectedFactory = _child(address(coord), 5);
    }

    function _factoryParams(address implA, address vaultA, address collectorA, address hookAddr)
        internal
        view
        returns (HydeTokenFactory.ConstructorParams memory p)
    {
        p = HydeTokenFactory.ConstructorParams({
            impl: implA, collector: collectorA, vault: vaultA, hook: hookAddr, poolManager: POOL_MANAGER,
            positionManager: POSITION_MANAGER, permit2: PERMIT2, launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: LAUNCH_TREASURY, weth: WETH, universalRouter: UNIVERSAL_ROUTER, tickSpacing: TICK_SPACING,
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

    function _wethKey(address token) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = token < WETH
            ? (Currency.wrap(token), Currency.wrap(WETH))
            : (Currency.wrap(WETH), Currency.wrap(token));
        return PoolKey({currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: TICK_SPACING, hooks: IHooks(address(hydeHook))});
    }

    function _child(address coord, uint8 n) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), coord, bytes1(n))))));
    }
}
