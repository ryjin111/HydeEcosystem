// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateView} from "v4-periphery/src/lens/StateView.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {HydeERC20} from "../../src/HydeERC20.sol";
import {HydeFeeVault} from "../../src/HydeFeeVault.sol";
import {HydeFeeCollector} from "../../src/HydeFeeCollector.sol";
import {HydeHook} from "../../src/HydeHook.sol";
import {HydeTokenFactory} from "../../src/HydeTokenFactory.sol";
import {HoodieLaunchEngine} from "../../src/HoodieLaunchEngine.sol";
import {HoodieLauncher} from "../../src/HoodieLauncher.sol";
import {HoodieMetaFactory} from "../../src/HoodieMetaFactory.sol";
import {IHydeHook} from "../../src/interfaces/IHydeHook.sol";
import {IHydeVault} from "../../src/interfaces/IHydeVault.sol";

import {HydeStackSetup} from "./HydeStackSetup.sol";
// Pull the posm-artifact force-imports (PositionManager/PositionDescriptor/proxy) into THIS suite's import
// graph so a `--match-contract HoodieLauncherTest` sparse compile still emits their artifacts — otherwise
// `deployPosm`'s string `vm.getCode` throws "no matching artifact" at setUp under any `--match*` filter
// ([[reference_forge_getcode_sparse]]). No-op for a plain `forge test`. This is what makes kami's exact
// gated command (`forge test --match-contract HoodieLauncherTest --force -vv`) reproducible.
import "./ForceCompile.sol";

/// @notice Deploys the FULL Hoodie "launcher-launcher" stack (Option C): the audited vault/collector/HOOK
///         (UNCHANGED) bound once to a single `HoodieLaunchEngine` (= `HydeTokenFactory` with base == the REAL
///         4663 $HOODIE address), plus the `HoodieMetaFactory` + `HoodieLauncher` impl. Reuses `HydeStackSetup`
///         purely for the shared config constants + deployed-handle fields; it OVERRIDES `setUp` so the plain
///         WETH factory is never deployed (the hook binds to the engine, not a plain factory).
///
///         The base is forced to the canonical $HOODIE CA `0xC72c…402Ba3` via `deployCodeTo` so the
///         meta-factory's compile-time `HOODIE` constant + its `engine.WETH() == HOODIE` deploy-assert hold
///         against the same address a mainnet/testnet-fork run would use.
abstract contract HoodieStackSetup is HydeStackSetup {
    /// @dev Robinhood 4663 $HOODIE (Doppler DERC20, 18-dec) — matches `HoodieMetaFactory.HOODIE`.
    address internal constant HOODIE = 0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3;

    HoodieLaunchEngine internal engine;
    HoodieLauncher internal launcherImpl;
    HoodieMetaFactory internal metaFactory;

    /// @dev per-creator counter so repeated `_newLauncher(creator)` calls mint distinct launchers.
    mapping(address => uint256) private _launcherSaltNonce;

    function setUp() public virtual override {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        deployPosm(manager);
        _deployHoodieStack();
    }

    function _deployHoodieStack() internal {
        impl = new HydeERC20();

        // Place a HOODIE mock at the canonical CA so the engine/meta-factory HOODIE-assert is exercised.
        // Filter-safe: `new MockERC20` (compile-time type, referenced ⇒ never sparse-pruned) then `vm.etch`
        // its runtime code to the canonical address — NOT `deployCodeTo("…:MockERC20")`, whose string-artifact
        // resolution throws `vm.getCode: no matching artifact` under any `--match*` filter on this box
        // ([[reference_forge_getcode_sparse]]). solmate `decimals` is an immutable baked into runtime code, so
        // the etched HOODIE reports 18; `mint`/`transfer` are runtime fns preserved by the etch.
        MockERC20 hoodieMock = new MockERC20("Hoodie", "HOODIE", 18);
        vm.etch(HOODIE, address(hoodieMock).code);
        weth = MockERC20(HOODIE);

        stateView = new StateView(manager);

        address deployer = address(this);
        uint256 nonce = vm.getNonce(deployer);
        address vaultAddr = vm.computeCreateAddress(deployer, nonce);
        address collectorAddr = vm.computeCreateAddress(deployer, nonce + 1);

        // Mine the (unchanged) hook to the §4c permission bits against the predicted vault + HOODIE base.
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        bytes memory hookArgs =
            abi.encode(manager, vaultAddr, HOODIE, START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY);
        (address hookAddr, bytes32 hookSalt) = HookMiner.find(deployer, flags, type(HydeHook).creationCode, hookArgs);

        vault = new HydeFeeVault(
            IERC20(HOODIE),
            collectorAddr,
            manager,
            IHydeHook(hookAddr),
            TICK_SPACING,
            HYDE_TREASURY,
            HYDE_BPS,
            NET_BPS,
            MAX_SLIPPAGE,
            TWAP_WINDOW,
            int24(200)
        );
        require(address(vault) == vaultAddr, "VAULT_ADDR");

        collector = new HydeFeeCollector(
            lpm,
            manager,
            IHydeVault(address(vault)),
            HOODIE,
            IHydeHook(hookAddr),
            permit2,
            stateView,
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

        // Launcher implementation cloned by the meta-factory.
        launcherImpl = new HoodieLauncher();

        // Engine construction params — identical shape to the WETH factory, base == HOODIE (INV-1/2).
        HydeTokenFactory.ConstructorParams memory p = HydeTokenFactory.ConstructorParams({
            impl: address(impl),
            collector: address(collector),
            vault: address(vault),
            hook: address(hydeHook),
            poolManager: address(manager),
            positionManager: address(lpm),
            permit2: address(permit2),
            launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: LAUNCH_TREASURY,
            weth: HOODIE,
            universalRouter: address(swapRouter),
            tickSpacing: TICK_SPACING,
            maxSeedDust: MAX_SEED_DUST,
            maxWalletBps: MAX_WALLET_BPS,
            maxWalletWindowSecs: MAX_WALLET_WINDOW,
            graduationThreshold: GRAD_THRESHOLD,
            owner: FACTORY_OWNER
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

        // META_FACTORY is an engine immutable → predict its CREATE address (it deploys immediately AFTER the
        // engine, with no intervening CREATE, so its nonce == the engine's nonce + 1).
        address predictedMeta = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        engine = new HoodieLaunchEngine(p, presets, predictedMeta);
        metaFactory = new HoodieMetaFactory(address(engine), address(launcherImpl));
        require(address(metaFactory) == predictedMeta, "META_ADDR");

        // Bind the (unchanged) hook/vault/collector to the ENGINE — the ONE factory they trust.
        vault.initFactory(address(engine));
        collector.initFactory(address(engine));
        hydeHook.initFactory(address(engine));
    }

    /* ─────────────────────────── helpers ───────────────────────────────────── */
    /// @dev Mint a fresh launcher clone owned by `creator` (distinct per call via an incrementing userSalt).
    function _newLauncher(address creator) internal returns (HoodieLauncher l) {
        bytes32 userSalt = bytes32(_launcherSaltNonce[creator]++);
        vm.prank(creator);
        l = HoodieLauncher(metaFactory.createLauncher(userSalt));
    }

    /// @dev Launch a HOODIE-paired token: `creator` funds the flat fee and calls the launcher (one payable tx).
    function _hoodieLaunch(address creator, HoodieLauncher launcher, string memory name, string memory symbol)
        internal
        returns (address token, uint256 tokenId)
    {
        vm.deal(creator, LAUNCH_FEE);
        vm.prank(creator);
        (token, tokenId) = launcher.launch{value: LAUNCH_FEE}(name, symbol, 0);
    }

    /// @dev The launched pool key (currencies sorted, dynamic fee, HOOK), base == HOODIE.
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
}
