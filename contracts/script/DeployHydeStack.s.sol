// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IStateView} from "v4-periphery/src/interfaces/IStateView.sol";
import {StateView} from "v4-periphery/src/lens/StateView.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {HydeERC20} from "../src/HydeERC20.sol";
import {HydeFeeVault} from "../src/HydeFeeVault.sol";
import {HydeFeeCollector} from "../src/HydeFeeCollector.sol";
import {HydeHook} from "../src/HydeHook.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";
import {IHydeHook} from "../src/interfaces/IHydeHook.sol";
import {IHydeVault} from "../src/interfaces/IHydeVault.sol";

/// @notice Shared stack config (TEST params — mirror the 46/46 harness). Mainnet swaps the real sheet.
abstract contract HydeDeployConfig {
    int24 internal constant TICK_SPACING = 60;
    uint24 internal constant START_FEE = 30_000; // 3%
    uint24 internal constant BASE_FEE = 10_000; // 1%
    uint24 internal constant MAX_LP_FEE_CAP = 50_000; // 5%
    uint32 internal constant ANTI_SNIPE_WINDOW = 300;
    // FINDING-2/5: the ring must SPAN the TWAP window (in SECONDS) or an active pool can churn it past
    // `now − TWAP_WINDOW` and DoS settle/compound (ORACLE_NOT_READY). `afterSwap` coalesces same-second
    // swaps (`dt == 0` ⇒ no slot), so the ring consumes at most ONE slot per DISTINCT SECOND regardless
    // of block time; the sizing rule is therefore block-time-INDEPENDENT: `CARDINALITY > TWAP_WINDOW`
    // (seconds) + headroom. 2048 > 1800 retains a full 1800s of one-slot/second history with margin;
    // the former 1024 ≤ 1800 could be evicted. Raising the ring is cheap now (`_interpolateAtTarget` is
    // O(log n) binary-search): if TWAP_WINDOW is ever increased, keep CARDINALITY > it.
    uint16 internal constant CARDINALITY = 2048;
    uint16 internal constant HYDE_BPS = 500;
    uint16 internal constant LIQ_BPS = 500;
    uint16 internal constant NET_BPS = 9500;
    uint16 internal constant MAX_SLIPPAGE = 300;
    uint32 internal constant TWAP_WINDOW = 1800;
    uint128 internal constant MIN_ADD_LIQUIDITY = 1e6;
    int24 internal constant MAX_ADD_DEV_TICKS = 200;
    // FINDING-3: spot-vs-TWAP band the settle swap tolerates — mirrors the collector's compound
    // add-gate (same 200-tick band) so a manipulated spot can't drag the settle floor down.
    int24 internal constant MAX_SETTLE_DEV_TICKS = 200;
    uint256 internal constant MAX_SEED_DUST = 1e18;
    uint256 internal constant GRAD_THRESHOLD = 0; // label-only; graduate is stubbed
    uint16 internal constant MAX_WALLET_BPS = 100; // 1% (test)
    uint64 internal constant MAX_WALLET_WINDOW = 300;
    uint256 internal constant LAUNCH_FEE = 0.0004 ether; // flat native-ETH launch fee (4e14 wei)
    int24 internal constant C0_INIT = -60_000;
    int24 internal constant C0_LOWER = 0;
    int24 internal constant C0_UPPER = 60_000;
    int24 internal constant C1_INIT = 60_000;
    int24 internal constant C1_LOWER = -60_000;
    int24 internal constant C1_UPPER = 0;
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
    );

    /// @dev CREATE address of `d`'s nonce `n` (n in [1,0x7f]) — used to pre-predict the vault/weth
    ///      addresses the hook-mine is computed against (matches the on-chain CREATE the Deployer does).
    function _create1(address d, uint8 n) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), d, bytes1(n))))));
    }
}

/// @notice Single deployer contract for the whole own-stack — this is what makes it work: because ALL of
///         vault/collector/hook are created BY THIS CONTRACT, `new HydeHook{salt}` CREATE2s with `this` as
///         the deployer (not Foundry's 0x4e59 proxy), and `this` is the consistent `_deployer` that can call
///         the one-shot `initFactory` on all three. Mirrors the proven harness (HydeStackSetup) exactly.
///         Fixed sandbox deploy order → deterministic nonces (impl1·stateView2·vault3·collector4·hook5·factory6).
contract HydeStackDeployer is HydeDeployConfig {
    address public weth;
    address public impl;
    address public stateView;
    address public vault;
    address public collector;
    address public hook;
    address public factory;

    struct Ext {
        IPoolManager manager;
        IPositionManager posm;
        IAllowanceTransfer permit2;
        address universalRouter;
        address weth; // REAL testnet WETH for the live deploy (or a script-deployed mock)
        address hydeTreasury;
        address launchTreasury;
        address factoryOwner;
        bytes32 hookSalt; // off-chain-mined in the script (no on-chain mining gas)
        address expectedHook;
    }

    constructor(Ext memory e) {
        // WETH comes in as a param (real testnet addr or a script-deployed mock) so the LIVE deploy
        // points at the real WETH — clint's faucet-ETH → wrap → trade works against the real pool.
        weth = e.weth;
        impl = address(new HydeERC20()); // nonce 1
        stateView = address(new StateView(e.manager)); // nonce 2 (46630 has no canonical StateView)

        address vaultA = _create1(address(this), 3);
        address collectorA = _create1(address(this), 4);

        vault = address(
            new HydeFeeVault(
                IERC20(weth), collectorA, e.manager, IHydeHook(e.expectedHook),
                TICK_SPACING, e.hydeTreasury, HYDE_BPS, NET_BPS, MAX_SLIPPAGE, TWAP_WINDOW, MAX_SETTLE_DEV_TICKS
            )
        ); // nonce 5
        require(vault == vaultA, "VAULT_ADDR");

        collector = address(
            new HydeFeeCollector(
                e.posm, e.manager, IHydeVault(vault), weth, IHydeHook(e.expectedHook), e.permit2,
                IStateView(stateView), TICK_SPACING, LIQ_BPS, NET_BPS, MIN_ADD_LIQUIDITY, MAX_ADD_DEV_TICKS, TWAP_WINDOW
            )
        ); // nonce 6
        require(collector == collectorA, "COLLECTOR_ADDR");

        // CREATE2 from THIS contract → deployer = this (matches the off-chain mine); ctor self-asserts bits.
        hook = address(
            new HydeHook{salt: e.hookSalt}(
                e.manager, vault, weth, START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY
            )
        );
        require(hook == e.expectedHook, "HOOK_ADDR");

        factory = _deployFactory(e);

        // one-shot wiring — msg.sender == this == the deployer of all three (fixes ONLY_DEPLOYER).
        HydeFeeVault(vault).initFactory(factory);
        HydeFeeCollector(collector).initFactory(factory);
        HydeHook(hook).initFactory(factory);
    }

    function _deployFactory(Ext memory e) internal returns (address) {
        HydeTokenFactory.ConstructorParams memory p = HydeTokenFactory.ConstructorParams({
            impl: impl,
            collector: collector,
            vault: vault,
            hook: hook,
            poolManager: address(e.manager),
            positionManager: address(e.posm),
            permit2: address(e.permit2),
            launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: e.launchTreasury,
            weth: weth,
            universalRouter: e.universalRouter,
            tickSpacing: TICK_SPACING,
            maxSeedDust: MAX_SEED_DUST,
            maxWalletBps: MAX_WALLET_BPS,
            maxWalletWindowSecs: MAX_WALLET_WINDOW,
            graduationThreshold: GRAD_THRESHOLD,
            owner: e.factoryOwner
        });
        HydeTokenFactory.PresetInput[] memory presets = new HydeTokenFactory.PresetInput[](1);
        presets[0] = HydeTokenFactory.PresetInput({
            initialTick0: C0_INIT, tickLower0: C0_LOWER, tickUpper0: C0_UPPER,
            initialTick1: C1_INIT, tickLower1: C1_LOWER, tickUpper1: C1_UPPER
        });
        return address(new HydeTokenFactory(p, presets));
    }
}

/// @notice TESTNET (Robinhood 46630) deploy driver. Predicts the Deployer's address + the weth/vault it
///         will CREATE, mines the hook off-chain against those, then deploys the Deployer (which builds +
///         wires the whole stack atomically). TEST params only; mainnet uses the real sheet + real infra.
///
///   Simulate (NO broadcast):  forge script script/DeployHydeStack.s.sol --rpc-url $TESTNET_RPC
///   Broadcast (testnet only): forge script script/DeployHydeStack.s.sol --rpc-url $TESTNET_RPC --broadcast
contract DeployHydeStack is Script, HydeDeployConfig {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        HydeStackDeployer.Ext memory e;
        e.manager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        e.posm = IPositionManager(payable(vm.envAddress("POSITION_MANAGER")));
        e.permit2 = IAllowanceTransfer(vm.envAddress("PERMIT2"));
        e.universalRouter = vm.envAddress("UNIVERSAL_ROUTER");
        e.hydeTreasury = vm.envOr("HYDE_TREASURY", deployer);
        e.launchTreasury = vm.envOr("LAUNCH_TREASURY", deployer);
        e.factoryOwner = vm.envOr("FACTORY_OWNER", deployer);

        vm.startBroadcast(pk);

        // Resolve WETH/USDG (REAL testnet addrs via env, else script-deployed mocks) inside the broadcast
        // so the Deployer-address prediction below accounts for their nonces.
        address weth = vm.envOr("WETH", address(0));
        if (weth == address(0)) weth = address(new MockERC20("Wrapped Ether", "WETH", 18));
        e.weth = weth;

        // The EOA deploys the Deployer next → addr = CREATE(EOA, currentNonce). Inside it: impl(1),
        // stateView(2), vault(3) — mine the hook against that predicted vault + the resolved weth.
        address deployerAddr = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        address vaultA = _create1(deployerAddr, 3);
        bytes memory hookArgs =
            abi.encode(e.manager, vaultA, weth, START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY);
        (address hookAddr, bytes32 hookSalt) =
            HookMiner.find(deployerAddr, HOOK_FLAGS, type(HydeHook).creationCode, hookArgs);
        e.hookSalt = hookSalt;
        e.expectedHook = hookAddr;

        HydeStackDeployer d = new HydeStackDeployer(e);
        vm.stopBroadcast();

        require(d.hook() == hookAddr, "HOOK_MINE_DRIFT");

        console2.log("== Hyde own-stack deployed (46630 testnet) ==");
        console2.log("Deployer    ", address(d));
        console2.log("WETH        ", d.weth());
        console2.log("HydeERC20   ", d.impl());
        console2.log("StateView   ", d.stateView());
        console2.log("Vault       ", d.vault());
        console2.log("Collector   ", d.collector());
        console2.log("Hook        ", d.hook());
        console2.log("Factory     ", d.factory());
    }
}
