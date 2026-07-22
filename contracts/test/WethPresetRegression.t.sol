// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {HydeStackSetup} from "./support/HydeStackSetup.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";
import {WethRedeployPreset} from "../script/WethRedeployPreset.sol";

/// @notice Deterministic regression for the WETH-stack $5k-FDV redeploy preset (gojo 24039 / kami 24040;
///         clint 24036, HOODIE-parity). CONSUMES the SAME source of truth the deploy uses —
///         `WethRedeployPreset` (kami 24054) — so it can NEVER validate ticks that drift from what
///         DeployWethStack4663 actually ships. Builds a real factory with that preset against a real V4 (no
///         fork/RPC) and pins: exact six ticks, mirror-consistent legs, and the EXACT derived per-leg
///         liquidity (the economic anchor — any tick drift moves it and fails here). WETH-stack ONLY: the
///         shared HOODIE preset (HydeStackSetup C0_*/C1_* = ±60000) is untouched and asserted distinct.
contract WethPresetRegressionTest is HydeStackSetup {
    function _wethCtorParams() internal view returns (HydeTokenFactory.ConstructorParams memory) {
        return HydeTokenFactory.ConstructorParams({
            impl: address(impl),
            collector: address(collector),
            vault: address(vault),
            hook: address(hydeHook),
            poolManager: address(manager),
            positionManager: address(lpm),
            permit2: address(permit2),
            launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: LAUNCH_TREASURY,
            weth: address(weth),
            universalRouter: address(swapRouter),
            tickSpacing: TICK_SPACING,
            maxSeedDust: MAX_SEED_DUST,
            maxWalletBps: MAX_WALLET_BPS,
            maxWalletWindowSecs: MAX_WALLET_WINDOW,
            graduationThreshold: GRAD_THRESHOLD,
            owner: FACTORY_OWNER
        });
    }

    /// The shared-source WETH preset builds with EXACTLY its declared ticks on both sort branches, mirror
    /// liquidity, and the pinned exact derived liquidity. A wrong-preset redeploy is caught here.
    function test_weth_preset_contents_and_liquidity() public {
        HydeTokenFactory.PresetInput[] memory presets = new HydeTokenFactory.PresetInput[](1);
        presets[0] = WethRedeployPreset.preset(); // consume the deploy's source of truth (no duplicated ticks)

        HydeTokenFactory f = new HydeTokenFactory(_wethCtorParams(), presets);
        HydeTokenFactory.Preset memory p0 = f.getPreset(0);

        // Built preset holds EXACTLY the shared-source ticks (both sort branches).
        assertEq(p0.c0.initialTick, WethRedeployPreset.C0_INIT, "c0 init");
        assertEq(p0.c0.tickLower, WethRedeployPreset.C0_LOWER, "c0 lower");
        assertEq(p0.c0.tickUpper, WethRedeployPreset.C0_UPPER, "c0 upper");
        assertEq(p0.c1.initialTick, WethRedeployPreset.C1_INIT, "c1 init");
        assertEq(p0.c1.tickLower, WethRedeployPreset.C1_LOWER, "c1 lower");
        assertEq(p0.c1.tickUpper, WethRedeployPreset.C1_UPPER, "c1 upper");

        // Economic anchor: mirror + EXACT derived liquidity (drifting any tick changes this and fails).
        assertEq(p0.c0.liquidity, p0.c1.liquidity, "legs mirror");
        console2.log("WETH_PRESET_LIQUIDITY", uint256(p0.c0.liquidity));
        assertEq(p0.c0.liquidity, WethRedeployPreset.EXPECTED_LIQUIDITY, "pinned liquidity"); // exact ⇒ > 0
    }

    /// Guard: the shared-source vector is NOT the incident ±60000 preset (proves the fix was not reverted).
    /// Compares the consumed source against HydeStackSetup's incident preset constants.
    function test_not_incident_preset() public pure {
        assertTrue(
            WethRedeployPreset.C0_UPPER != C0_UPPER || WethRedeployPreset.C0_INIT != C0_INIT,
            "must differ from incident +/-60000"
        );
    }
}
