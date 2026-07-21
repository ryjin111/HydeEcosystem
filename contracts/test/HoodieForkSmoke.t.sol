// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IStateView} from "v4-periphery/src/interfaces/IStateView.sol";
import {StateView} from "v4-periphery/src/lens/StateView.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {HydeDeployConfig} from "../script/DeployHydeStack.s.sol";
import {HydeERC20} from "../src/HydeERC20.sol";
import {HydeFeeVault} from "../src/HydeFeeVault.sol";
import {HydeFeeCollector} from "../src/HydeFeeCollector.sol";
import {HydeHook} from "../src/HydeHook.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";
import {IHydeHook} from "../src/interfaces/IHydeHook.sol";
import {IHydeVault} from "../src/interfaces/IHydeVault.sol";
import {HoodieLaunchEngine} from "../src/HoodieLaunchEngine.sol";
import {HoodieLauncher} from "../src/HoodieLauncher.sol";
import {HoodieMetaFactory} from "../src/HoodieMetaFactory.sol";

/// @notice Doppler DERC20 surface used for the graduation precondition.
interface IDopplerToken {
    function pool() external view returns (address);
    function decimals() external view returns (uint8);
}

/// @notice REAL-FORK smoke (Robinhood MAINNET 4663) proving the HOODIE launcher-launcher against the ACTUAL
///         on-chain $HOODIE token + the live V4 core. HOODIE does NOT exist on testnet 46630 (code == 0x), so
///         this gate MUST run on a 4663 fork (gojo 23403). Env-gated on `HOODIE_FORK_RPC` — a no-op skip when
///         unset, so plain `forge test` stays green offline. Building against real infra does NOT lift the
///         mainnet-broadcast NO-GO; this only proves the code works on real state.
///           HOODIE_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/HoodieForkSmoke.t.sol -vv
contract HoodieForkSmoke is Test, HydeDeployConfig {
    /* ─────────── gojo-verified 4663 set (extcodehash-pinned; assert on fork to fail loud on drift) ── */
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant HOODIE = 0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3;

    bytes32 internal constant HOODIE_CODEHASH = 0xf10f86b05965a827a332e6c73086f18026fbe3917f4bffbec3f938b3b5397b56;
    bytes32 internal constant POOL_MANAGER_CODEHASH =
        0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;
    bytes32 internal constant POSITION_MANAGER_CODEHASH =
        0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2;
    bytes32 internal constant PERMIT2_CODEHASH = 0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca;
    bytes32 internal constant STATE_VIEW_CODEHASH = 0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6;

    // Doppler post-migration sentinel: `pool()` returns the FULL dead address once the auction transfer-lock
    // is released (HOODIE graduated + freely transferable). Verified live on the 4663 fork: HOODIE.pool() ==
    // 0xdeaD…DEaD (the 20-byte 0xDE/0xAD pattern), NOT the short 0x00…dEaD. Pre-graduation this is the live pool.
    address internal constant DOPPLER_GRADUATED = 0xdeaDDeADDEaDdeaDdEAddEADDEAdDeadDEADDEaD;

    IPoolManager internal manager;
    IPositionManager internal lpm;
    StateView internal stateView;

    HydeERC20 internal impl;
    HydeFeeVault internal vault;
    HydeFeeCollector internal collector;
    HydeHook internal hydeHook;
    HoodieLaunchEngine internal engine;
    HoodieLauncher internal launcherImpl;
    HoodieMetaFactory internal metaFactory;

    address internal alice = makeAddr("alice");
    bool internal enabled;

    // re-declared for expectEmit topic matching
    event PositionRegistered(address indexed token, address indexed creator, uint256 tokenId);

    function setUp() public {
        string memory rpc = vm.envOr("HOODIE_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return; // no RPC → skip (keeps the normal suite green offline)
        enabled = true;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663, "not a 4663 fork");

        // (a) Tamper-evidence: the pinned infra must match byte-for-byte, else the fork state drifted.
        assertEq(_codehash(POOL_MANAGER), POOL_MANAGER_CODEHASH, "poolManager codehash drift");
        assertEq(_codehash(POSITION_MANAGER), POSITION_MANAGER_CODEHASH, "positionManager codehash drift");
        assertEq(_codehash(PERMIT2), PERMIT2_CODEHASH, "permit2 codehash drift");
        assertEq(_codehash(STATE_VIEW), STATE_VIEW_CODEHASH, "stateView codehash drift");
        assertEq(_codehash(HOODIE), HOODIE_CODEHASH, "HOODIE proxy codehash drift");

        // (b) Graduation precondition: HOODIE must be graduated (transfer-lock released) + 18-dec, or a launch
        //     pool through it would hit DERC20's pre-graduation transfer restriction (gojo 23403 gotcha 2).
        assertEq(IDopplerToken(HOODIE).decimals(), 18, "HOODIE not 18-dec");
        assertEq(IDopplerToken(HOODIE).pool(), DOPPLER_GRADUATED, "HOODIE not graduated (pool != dead sentinel)");

        manager = IPoolManager(POOL_MANAGER);
        lpm = IPositionManager(payable(POSITION_MANAGER));
        stateView = StateView(STATE_VIEW);

        _deployHoodieStackOnFork();
    }

    /// @dev Deploy the Hoodie stack against the REAL forked V4 core, base == the REAL HOODIE (no WETH: gotcha 3).
    function _deployHoodieStackOnFork() internal {
        address deployer = address(this);
        impl = new HydeERC20();

        uint256 nonce = vm.getNonce(deployer);
        address vaultAddr = vm.computeCreateAddress(deployer, nonce);
        address collectorAddr = vm.computeCreateAddress(deployer, nonce + 1);

        bytes memory hookArgs =
            abi.encode(manager, vaultAddr, HOODIE, START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY);
        (address hookAddr, bytes32 hookSalt) = HookMiner.find(deployer, HOOK_FLAGS, type(HydeHook).creationCode, hookArgs);

        vault = new HydeFeeVault(
            IERC20(HOODIE),
            collectorAddr,
            manager,
            IHydeHook(hookAddr),
            TICK_SPACING,
            makeAddr("hydeTreasury"),
            HYDE_BPS,
            NET_BPS,
            MAX_SLIPPAGE,
            TWAP_WINDOW,
            MAX_SETTLE_DEV_TICKS
        );
        require(address(vault) == vaultAddr, "VAULT_ADDR");

        collector = new HydeFeeCollector(
            lpm,
            manager,
            IHydeVault(address(vault)),
            HOODIE,
            IHydeHook(hookAddr),
            IAllowanceTransfer(PERMIT2),
            IStateView(STATE_VIEW),
            TICK_SPACING,
            LIQ_BPS,
            NET_BPS,
            MIN_ADD_LIQUIDITY,
            MAX_ADD_DEV_TICKS,
            TWAP_WINDOW
        );
        require(address(collector) == collectorAddr, "COLLECTOR_ADDR");

        hydeHook = new HydeHook{salt: hookSalt}(
            manager, address(vault), HOODIE, START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY
        );
        require(address(hydeHook) == hookAddr, "HOOK_ADDR");

        launcherImpl = new HoodieLauncher();

        HydeTokenFactory.ConstructorParams memory p = HydeTokenFactory.ConstructorParams({
            impl: address(impl),
            collector: address(collector),
            vault: address(vault),
            hook: address(hydeHook),
            poolManager: POOL_MANAGER,
            positionManager: POSITION_MANAGER,
            permit2: PERMIT2,
            launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: makeAddr("launchTreasury"),
            weth: HOODIE, // base IS HOODIE (no WETH in this stack)
            universalRouter: UNIVERSAL_ROUTER,
            tickSpacing: TICK_SPACING,
            maxSeedDust: MAX_SEED_DUST,
            maxWalletBps: MAX_WALLET_BPS,
            maxWalletWindowSecs: MAX_WALLET_WINDOW,
            graduationThreshold: GRAD_THRESHOLD,
            owner: makeAddr("factoryOwner")
        });
        HydeTokenFactory.PresetInput[] memory presets = new HydeTokenFactory.PresetInput[](1);
        presets[0] = HydeTokenFactory.PresetInput({
            initialTick0: C0_INIT,
            tickLower0: C0_LOWER,
            tickUpper0: C0_UPPER,
            initialTick1: C1_INIT,
            tickLower1: C1_LOWER,
            tickUpper1: C1_UPPER
        });

        address predictedMeta = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        engine = new HoodieLaunchEngine(p, presets, predictedMeta);
        metaFactory = new HoodieMetaFactory(address(engine), address(launcherImpl));
        require(address(metaFactory) == predictedMeta, "META_ADDR");

        vault.initFactory(address(engine));
        collector.initFactory(address(engine));
        hydeHook.initFactory(address(engine));
    }

    /* ─── the full real-4663 launcher-launcher loop ───────────────────────────── */
    function test_fork_hoodie_launcherLauncher_realInfra() public {
        if (!enabled) return; // skipped without HOODIE_FORK_RPC

        // 1) A user mints their own launcher via the meta-factory (the "launcher launcher" mechanic).
        vm.prank(alice);
        HoodieLauncher launcher = HoodieLauncher(metaFactory.createLauncher(bytes32("hoodie")));
        assertTrue(engine.isLauncher(address(launcher)), "launcher not registered");

        // 2) LAUNCH through the launcher on real infra — the human is attributed (90%-fee-routing truthful).
        address predicted = engine.predictNextFor(address(launcher), alice, "SHRIMP");
        vm.expectEmit(true, true, false, false, address(collector));
        emit PositionRegistered(predicted, alice, 0);

        vm.deal(alice, LAUNCH_FEE);
        vm.prank(alice);
        (address token, uint256 tokenId) = launcher.launch{value: LAUNCH_FEE}("Shrimp", "SHRIMP", 0);
        assertEq(token, predicted, "predicted != deployed");

        // 3) Prove the launched pool exists on real V4 and is HOODIE-paired (spot price set at the sorted key).
        PoolKey memory key = _hoodieKey(token);
        (uint160 sqrtPriceX96,,,) = stateView.getSlot0(key.toId());
        assertTrue(sqrtPriceX96 != 0, "pool not initialized at HOODIE pair on real 4663");

        // 4) Full 1B seeded to the REAL PoolManager; position NFT custody-locked in the collector.
        assertGe(
            IERC20(token).balanceOf(POOL_MANAGER), 1_000_000_000e18 - MAX_SEED_DUST, "100% seeded to real PoolManager"
        );
        assertEq(IERC721(POSITION_MANAGER).ownerOf(tokenId), address(collector), "position not custody-locked");

        console2.log("HOODIE-paired launch OK on real 4663:", token);
    }

    function _hoodieKey(address token) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = token < HOODIE
            ? (Currency.wrap(token), Currency.wrap(HOODIE))
            : (Currency.wrap(HOODIE), Currency.wrap(token));
        return PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hydeHook))
        });
    }

    function _codehash(address a) internal view returns (bytes32 h) {
        assembly {
            h := extcodehash(a)
        }
    }
}
