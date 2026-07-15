// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PosmTestSetup} from "v4-periphery/test/shared/PosmTestSetup.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {HydeERC20} from "../../src/HydeERC20.sol";
import {HydeFeeVault} from "../../src/HydeFeeVault.sol";
import {HydeFeeCollector} from "../../src/HydeFeeCollector.sol";
import {HydeHook} from "../../src/HydeHook.sol";
import {HydeTokenFactory} from "../../src/HydeTokenFactory.sol";
import {IHydeHook} from "../../src/interfaces/IHydeHook.sol";
import {IHydeVault} from "../../src/interfaces/IHydeVault.sol";

/// @notice Deploys the FULL Hyde own-stack against a REAL Uniswap V4 (PoolManager + PositionManager +
///         Permit2 from v4-periphery test utils), with the hook CREATE2-mined to the §4c permission bits.
///         Resolves the vault↔collector↔hook mutual-immutable cycle with ZERO changes to the audited
///         contracts: the vault's address is CREATE-nonce-predicted first (initcode-independent), the
///         hook is mined against it, then vault→collector→hook→factory deploy in order and are wired via
///         the one-shot deployer `initFactory`. Inherited by the lifecycle / factory / anti-rug suites.
abstract contract HydeStackSetup is PosmTestSetup {
    /* ─────────── stack config (mirror of the deploy manifest, test values) ──── */
    int24 internal constant TICK_SPACING = 60;
    uint24 internal constant START_FEE = 30_000; // 3%
    uint24 internal constant BASE_FEE = 10_000; // 1%
    uint24 internal constant MAX_LP_FEE_CAP = 50_000; // 5%
    uint32 internal constant ANTI_SNIPE_WINDOW = 300;
    uint16 internal constant CARDINALITY = 64;
    uint16 internal constant HYDE_BPS = 500;
    uint16 internal constant HOLDER_BPS = 500;
    uint32 internal constant DURATION = 7 days;
    uint16 internal constant MAX_SLIPPAGE = 300;
    uint32 internal constant TWAP_WINDOW = 120; // short for test oracle warmup (prod = 1800)
    uint256 internal constant MAX_SEED_DUST = 1e18; // 1 whole token out of 1e9
    uint256 internal constant GRAD_THRESHOLD = 0; // label-only; graduate is stubbed
    uint16 internal constant MAX_WALLET_BPS = 100; // 1%
    uint64 internal constant MAX_WALLET_WINDOW = 300;
    uint256 internal constant LAUNCH_FEE = 1e6; // $1 (6-dec USDG)

    // single validated preset (mirror-image single-sided legs for both sort branches)
    int24 internal constant C0_INIT = -60_000;
    int24 internal constant C0_LOWER = 0;
    int24 internal constant C0_UPPER = 60_000;
    int24 internal constant C1_INIT = 60_000;
    int24 internal constant C1_LOWER = -60_000;
    int24 internal constant C1_UPPER = 0;

    address internal constant HYDE_TREASURY = address(0x11DE);
    address internal constant LAUNCH_TREASURY = address(0xFEE5);
    address internal constant FACTORY_OWNER = address(0x0FF1CE);

    /* ─────────────────────────── deployed handles ──────────────────────────── */
    MockERC20 internal weth;
    MockERC20 internal usdg;
    HydeERC20 internal impl;
    HydeFeeVault internal vault;
    HydeFeeCollector internal collector;
    HydeHook internal hydeHook;
    HydeTokenFactory internal factory;

    function setUp() public virtual {
        // A large timestamp so the oracle's `now >= TWAP_WINDOW` guard holds from block one.
        vm.warp(1_000_000);
        deployFreshManagerAndRouters(); // sets `manager`, `swapRouter`, ...
        deployPosm(manager); // sets `lpm` (real PositionManager) + `permit2`
        _deployHydeStack(address(this)); // WETH low-address stack by default
    }

    /// @dev Deploy the stack. `wethAddr == address(0)` ⇒ a fresh mock; otherwise `deployCodeTo` a WETH
    ///      mock at the given address so tests can force the LT/WETH sort branch deterministically.
    function _deployHydeStack(address /*unused*/ ) internal {
        _deployHydeStackWithWeth(address(0));
    }

    function _deployHydeStackWithWeth(address forcedWeth) internal {
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        impl = new HydeERC20();
        if (forcedWeth == address(0)) {
            weth = new MockERC20("Wrapped Ether", "WETH", 18);
        } else {
            deployCodeTo("solmate/src/test/utils/mocks/MockERC20.sol:MockERC20", abi.encode("WETH", "WETH", uint8(18)), forcedWeth);
            weth = MockERC20(forcedWeth);
        }

        address deployer = address(this);
        uint256 nonce = vm.getNonce(deployer);
        address vaultAddr = vm.computeCreateAddress(deployer, nonce); // vault deploys next (CREATE)
        address collectorAddr = vm.computeCreateAddress(deployer, nonce + 1); // then the collector

        // Mine the hook to the §4c permission bits against the predicted vault address.
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        bytes memory hookArgs = abi.encode(
            manager, vaultAddr, address(weth), START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY
        );
        (address hookAddr, bytes32 hookSalt) = HookMiner.find(deployer, flags, type(HydeHook).creationCode, hookArgs);

        // vault (nonce) → vaultAddr
        vault = new HydeFeeVault(
            IERC20(address(weth)),
            collectorAddr,
            manager,
            IHydeHook(hookAddr),
            TICK_SPACING,
            HYDE_TREASURY,
            HYDE_BPS,
            HOLDER_BPS,
            DURATION,
            MAX_SLIPPAGE,
            TWAP_WINDOW
        );
        require(address(vault) == vaultAddr, "VAULT_ADDR");

        // collector (nonce+1) → collectorAddr
        collector = new HydeFeeCollector(lpm, manager, IHydeVault(address(vault)), address(weth));
        require(address(collector) == collectorAddr, "COLLECTOR_ADDR");

        // hook (CREATE2 mined) → hookAddr
        hydeHook = new HydeHook{salt: hookSalt}(
            manager, address(vault), address(weth), START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY
        );
        require(address(hydeHook) == hookAddr, "HOOK_ADDR");

        // factory
        HydeTokenFactory.ConstructorParams memory p = HydeTokenFactory.ConstructorParams({
            impl: address(impl),
            collector: address(collector),
            vault: address(vault),
            hook: address(hydeHook),
            poolManager: address(manager),
            positionManager: address(lpm),
            permit2: address(permit2),
            usdg: address(usdg),
            launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: LAUNCH_TREASURY,
            weth: address(weth),
            universalRouter: address(swapRouter), // stand-in router in tests
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
        factory = new HydeTokenFactory(p, presets);

        // wire the factory into the three one-shot bindings (deployer-only).
        vault.initFactory(address(factory));
        collector.initFactory(address(factory));
        hydeHook.initFactory(address(factory));
    }

    /* ─────────────────────────── helpers ───────────────────────────────────── */
    /// @dev Launch a token from `creator` (funds + approves the $1 USDG fee first).
    function _launch(address creator, string memory name, string memory symbol)
        internal
        returns (address token, uint256 tokenId)
    {
        usdg.mint(creator, LAUNCH_FEE);
        vm.startPrank(creator);
        usdg.approve(address(factory), LAUNCH_FEE);
        (token, tokenId) =
            factory.launch(HydeTokenFactory.LaunchParams({name: name, symbol: symbol, presetId: 0}));
        vm.stopPrank();
    }

    /// @dev The launch's pool key (currencies sorted, dynamic fee, HOOK).
    function _key(address token) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = token < address(weth)
            ? (Currency.wrap(token), Currency.wrap(address(weth)))
            : (Currency.wrap(address(weth)), Currency.wrap(token));
        return PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hydeHook))
        });
    }

    /// @dev A user buys `token` with `wethIn` WETH through the test swap router (WETH → LT).
    function _buy(address user, address token, uint256 wethIn) internal {
        weth.mint(user, wethIn);
        vm.startPrank(user);
        weth.approve(address(swapRouter), wethIn);
        bool wethIsC0 = address(weth) < token;
        PoolKey memory key = _key(token);
        // zeroForOne == swapping currency0→currency1: WETH-in means zeroForOne iff WETH is currency0.
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: wethIsC0,
                amountSpecified: -int256(wethIn), // exact input WETH
                sqrtPriceLimitX96: wethIsC0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    /// @dev A user sells `ltIn` of `token` back to WETH (generates an LT-side fee leg).
    function _sell(address user, address token, uint256 ltIn) internal {
        vm.startPrank(user);
        IERC20(token).approve(address(swapRouter), ltIn);
        bool ltIsC0 = token < address(weth);
        PoolKey memory key = _key(token);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: ltIsC0,
                amountSpecified: -int256(ltIn),
                sqrtPriceLimitX96: ltIsC0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }
}
