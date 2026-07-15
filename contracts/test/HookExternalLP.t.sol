// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HydeStackSetup} from "./support/HydeStackSetup.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @dev A minimal hook whose ONLY permission is `beforeRemoveLiquidity`, which REVERTS — i.e. exactly
///      the trap FINDING-1 prevents. Mined to an address carrying only BEFORE_REMOVE_LIQUIDITY_FLAG so
///      V4 init + add go straight to core, but every removal is routed here and bricked.
contract RemoveTrapHook {
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert("TRAPPED_LP");
    }
}

/// @notice FINDING-1 (casper) demonstration on REAL Uniswap V4: a hook carrying a stray remove bit TRAPS
///         external LPs (their `decreaseLiquidity` reverts); a hook WITHOUT it (HydeHook's exact profile)
///         lets external LPs freely remove. Proves both the trap the deploy-assert prevents AND that
///         INV-EXT holds for the correct permission profile.
contract HookExternalLPTest is HydeStackSetup {
    ModifyLiquidityParams internal ADD =
        ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: bytes32(0)});
    ModifyLiquidityParams internal REMOVE =
        ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: -1e18, salt: bytes32(0)});

    /// @dev A fresh two-token pool with the given hook, funded + approved for this LP (the test contract).
    function _pool(address hook) internal returns (PoolKey memory key) {
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (MockERC20 t0, MockERC20 t1) = address(a) < address(b) ? (a, b) : (b, a);
        key = PoolKey({
            currency0: Currency.wrap(address(t0)),
            currency1: Currency.wrap(address(t1)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });
        manager.initialize(key, SQRT_PRICE_1_1); // tick 0 → the [-600, 600] range is two-sided
        t0.mint(address(this), 1e24);
        t1.mint(address(this), 1e24);
        t0.approve(address(modifyLiquidityRouter), type(uint256).max);
        t1.approve(address(modifyLiquidityRouter), type(uint256).max);
    }

    /// NEGATIVE — the trap the deploy-assert prevents: a hook WITH the remove bit bricks removals.
    function test_removeBitHook_traps_external_LP_on_decrease() public {
        (address hookAddr, bytes32 salt) = HookMiner.find(
            address(this), uint160(Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG), type(RemoveTrapHook).creationCode, ""
        );
        RemoveTrapHook trap = new RemoveTrapHook{salt: salt}();
        require(address(trap) == hookAddr, "MINE");

        PoolKey memory key = _pool(hookAddr);
        modifyLiquidityRouter.modifyLiquidity(key, ADD, ""); // add → core (no add-bit) → succeeds

        // decrease → `beforeRemoveLiquidity` IS routed here → reverts → the LP is TRAPPED (honeypot).
        vm.expectRevert();
        modifyLiquidityRouter.modifyLiquidity(key, REMOVE, "");
    }

    /// POSITIVE — HydeHook's profile (no remove bit) lets external LPs freely remove (INV-EXT).
    function test_noRemoveBitHook_external_LP_can_decrease() public {
        // Control isolating the remove-bit variable: a hookless pool has no remove bit (== HydeHook's
        // profile), so removals route to core.
        PoolKey memory key = _pool(address(0));
        modifyLiquidityRouter.modifyLiquidity(key, ADD, "");
        modifyLiquidityRouter.modifyLiquidity(key, REMOVE, ""); // decrease → not hooked → SUCCEEDS (no revert)

        // And our REAL, correctly-mined hook shares that profile — it carries no remove bit, so live
        // external LPs on a launched pool are equally free to exit.
        assertFalse(
            Hooks.hasPermission(IHooks(address(hydeHook)), Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG),
            "HydeHook has NO remove bit - external LPs never trapped"
        );
    }
}
