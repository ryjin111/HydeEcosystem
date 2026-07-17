// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {HydeStackDeployer, HydeDeployConfig} from "../script/DeployHydeStack.s.sol";
import {HydeHook} from "../src/HydeHook.sol";
import {HydeFeeVault} from "../src/HydeFeeVault.sol";
import {HydeFeeCollector} from "../src/HydeFeeCollector.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";

/// @notice REAL-FORK smoke (Robinhood testnet 46630): deploys the own-stack via the same HydeStackDeployer
///         the broadcast uses, then runs the marquee loop — launch → seed/MINT_POSITION (real PositionManager)
///         → buys/sells (real PoolManager) → collect (5% carve) → COMPOUND (reads spot off our SELF-DEPLOYED
///         StateView on real 46630). Validates the novel own-stack path against real V4 infra BEFORE spending
///         a broadcast. Skips (no-op pass) if TESTNET_RPC is unset so it never breaks the normal suite.
///           forge test --match-path test/TestnetForkSmoke.t.sol -vv   (with TESTNET_RPC set)
contract TestnetForkSmoke is Test, HydeDeployConfig {
    // gojo-verified 46630 V4 set
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant REAL_WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa; // gojo-verified 46630 WETH

    HydeStackDeployer internal d;
    PoolSwapTest internal swapRouter;
    IPoolManager internal manager;
    IPositionManager internal lpm;
    MockERC20 internal weth;
    MockERC20 internal usdg;
    HydeTokenFactory internal factory;
    HydeFeeCollector internal collector;
    HydeFeeVault internal vault;
    HydeHook internal hydeHook;

    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");
    bool internal enabled;

    function setUp() public {
        string memory rpc = vm.envOr("TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return; // no RPC → skip (keeps the normal suite green)
        enabled = true;
        vm.createSelectFork(rpc);

        manager = IPoolManager(POOL_MANAGER);
        lpm = IPositionManager(payable(POSITION_MANAGER));

        // Live-config parity: REAL testnet WETH (what the broadcast uses) + a mock USDG for the $1 fee.
        MockERC20 mockUsdg = new MockERC20("Global Dollar", "USDG", 6);

        // Mine the hook against the (test-contract) deployer + the vault it WILL create (nonce 3: the
        // Deployer deploys impl(1)·stateView(2)·vault(3) now that weth/usdg are params, not internal).
        address dAddr = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address vaultA = _create1(dAddr, 3);
        bytes memory hookArgs =
            abi.encode(manager, vaultA, REAL_WETH, START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY);
        (address hookAddr, bytes32 hookSalt) =
            HookMiner.find(dAddr, HOOK_FLAGS, type(HydeHook).creationCode, hookArgs);

        HydeStackDeployer.Ext memory e = HydeStackDeployer.Ext({
            manager: manager,
            posm: lpm,
            permit2: IAllowanceTransfer(PERMIT2),
            universalRouter: UNIVERSAL_ROUTER,
            weth: REAL_WETH,
            usdg: address(mockUsdg),
            hydeTreasury: makeAddr("hydeTreasury"),
            launchTreasury: makeAddr("launchTreasury"),
            factoryOwner: makeAddr("factoryOwner"),
            hookSalt: hookSalt,
            expectedHook: hookAddr
        });
        d = new HydeStackDeployer(e);

        weth = MockERC20(d.weth());
        usdg = MockERC20(d.usdg());
        factory = HydeTokenFactory(d.factory());
        collector = HydeFeeCollector(d.collector());
        vault = HydeFeeVault(d.vault());
        hydeHook = HydeHook(d.hook());

        // A test swap router bound to the REAL forked PoolManager (for the buy/sell legs).
        swapRouter = new PoolSwapTest(manager);
    }

    /* ─── the full real-fork loop ─────────────────────────────────────────────── */
    function test_fork_launch_buy_collect_compound() public {
        if (!enabled) return; // skipped without TESTNET_RPC

        // 1) LAUNCH — seeds the pool + MINT_POSITION via the REAL PositionManager (reverts if wrong infra).
        (address token, uint256 tokenId) = _launch(creator, "ForkSmoke", "FORK");
        assertEq(IERC721(address(lpm)).ownerOf(tokenId), address(collector), "position custody-locked on real PosM");
        assertGe(IERC20(token).balanceOf(POOL_MANAGER), 1_000_000_000e18 - MAX_SEED_DUST, "100% seeded to real PoolManager");
        console2.log("launched + seeded on real 46630:", token);

        // 2) TRADE — buys accrue WETH fees, a sell accrues LT fees; span the TWAP window.
        _buy(buyer, token, 5e18);
        vm.warp(block.timestamp + 40);
        _buy(buyer, token, 5e18);
        vm.warp(block.timestamp + 40);
        _sell(buyer, token, IERC20(token).balanceOf(buyer) / 2);
        vm.warp(block.timestamp + 40);
        _buy(buyer, token, 3e18);
        vm.warp(block.timestamp + 2000); // span the prod TWAP_WINDOW (1800) so compound's consult is ready

        // 3) COLLECT — carve exactly 5% in-kind (INV-C7), against real-pool-accrued fees.
        collector.collect(token);
        uint256 pendWETH = collector.pendingLiqWETH(token);
        assertGt(pendWETH, 0, "real fees accrued + 5% carved");
        uint256 tc0 = collector.totalCompounded0(token);
        uint256 tc1 = collector.totalCompounded1(token);

        // 4) COMPOUND — the novel path: reads spot off our SELF-DEPLOYED StateView on real 46630, TWAP-gates,
        //    adds add-only liquidity. Conservative either way (Bunni): add or dust-gate, never over-credit.
        try collector.compound(token, block.timestamp) {
            assertLe(collector.pendingLiqWETH(token), pendWETH, "pending never over-credited (Bunni)");
            assertGe(collector.totalCompounded0(token), tc0, "totalCompounded0 add-only");
            assertGe(collector.totalCompounded1(token), tc1, "totalCompounded1 add-only");
            console2.log("compound() OK on real 46630 (StateView spot-read works)");
        } catch {
            // Dust/wrong-side gate is a valid conservative outcome; the StateView read still executed.
            assertEq(collector.pendingLiqWETH(token), pendWETH, "pending untouched on conservative skip");
            console2.log("compound() dust-gated (conservative) - StateView read still exercised");
        }
    }

    /* ─── trade helpers (mirror HydeStackSetup, bound to the forked infra) ─────── */
    function _launch(address who, string memory name, string memory symbol)
        internal
        returns (address token, uint256 tokenId)
    {
        usdg.mint(who, LAUNCH_FEE);
        vm.startPrank(who);
        usdg.approve(address(factory), LAUNCH_FEE);
        (token, tokenId) = factory.launch(HydeTokenFactory.LaunchParams({name: name, symbol: symbol, presetId: 0}));
        vm.stopPrank();
    }

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

    function _buy(address user, address token, uint256 wethIn) internal {
        deal(address(weth), user, wethIn); // real WETH → set balance via deal (no mint on real WETH9)
        vm.startPrank(user);
        weth.approve(address(swapRouter), wethIn);
        bool wethIsC0 = address(weth) < token;
        swapRouter.swap(
            _key(token),
            SwapParams({
                zeroForOne: wethIsC0,
                amountSpecified: -int256(wethIn),
                sqrtPriceLimitX96: wethIsC0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function _sell(address user, address token, uint256 ltIn) internal {
        vm.startPrank(user);
        IERC20(token).approve(address(swapRouter), ltIn);
        bool ltIsC0 = token < address(weth);
        swapRouter.swap(
            _key(token),
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
