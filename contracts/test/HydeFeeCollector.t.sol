// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HydeFeeCollector} from "../src/HydeFeeCollector.sol";
import {HydeERC20} from "../src/HydeERC20.sol";
import {MockPositionManager} from "./mocks/MockPositionManager.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice HydeFeeCollector — 90/5/5 split w/ LT-burn buyback leg, custody, disabled graduate
///         (spec §4 rev dcbb5cf, INV-1/2/3/18/19). This test contract is deployer + factory.
contract HydeFeeCollectorTest is Test {
    HydeFeeCollector internal collector;
    MockPositionManager internal pm;
    HydeERC20 internal lt; // the launch token (burnable buyback leg)
    MockERC20 internal num; // numéraire

    address internal creator = address(0xCEA1);
    address internal hydeout = address(0x7EA0);
    address internal sink = address(0x5111);
    uint256 internal constant TOKEN_ID = 42;
    uint256 internal constant THRESHOLD = 1_000e18;
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function setUp() public {
        pm = new MockPositionManager();
        collector = new HydeFeeCollector(pm, hydeout, sink, 500, 500);
        collector.initFactory(address(this)); // this == factory

        num = new MockERC20(6);

        // Launch token: collector must be THIS collector so the onlyCollector burn works; pm holds the
        // full supply (as poolRecipient) so it can pay LT fees; maxWalletBps = 1e4 → no effective cap.
        lt = new HydeERC20();
        address[] memory exempt = new address[](2);
        exempt[0] = address(pm);
        exempt[1] = address(collector);
        lt.initialize(
            HydeERC20.InitParams({
                name: "LT",
                symbol: "LT",
                poolRecipient: address(pm),
                collector: address(collector),
                maxWalletBps: 300, // locked max (3%); collector-flow transfers bypass via exempt/from-collector
                maxWalletWindowSecs: 3600,
                exemptAddrs: exempt
            })
        );

        pm.setPosition(TOKEN_ID, address(lt), address(num), 0, 0);
        collector.register(address(lt), creator, TOKEN_ID, address(num), THRESHOLD);
    }

    /* ─────────────────────── factory / register guards ─────────────────────── */
    function test_initFactory_only_once() public {
        vm.expectRevert(bytes("FACTORY_SET"));
        collector.initFactory(address(0xdead));
    }

    function test_initFactory_only_deployer() public {
        HydeFeeCollector fresh = new HydeFeeCollector(pm, hydeout, sink, 500, 500);
        vm.prank(address(0xB0B));
        vm.expectRevert(bytes("ONLY_DEPLOYER"));
        fresh.initFactory(address(0x1234));
    }

    function test_register_onlyFactory() public {
        vm.prank(address(0xB0B));
        vm.expectRevert(bytes("ONLY_FACTORY"));
        collector.register(address(0x1), creator, 1, address(num), THRESHOLD);
    }

    function test_register_twice_reverts() public {
        vm.expectRevert(bytes("REGISTERED"));
        collector.register(address(lt), creator, TOKEN_ID, address(num), THRESHOLD);
    }

    /* ─────────────────────── INV-2: bps immutable, 500 each ────────────────── */
    function test_bps_are_500() public view {
        assertEq(collector.hydeoutBps(), 500);
        assertEq(collector.buybackBps(), 500);
    }

    function test_constructor_rejects_bad_config() public {
        vm.expectRevert(bytes("BPS"));
        new HydeFeeCollector(pm, hydeout, sink, 501, 500);
        vm.expectRevert(bytes("ZERO_RECIPIENT"));
        new HydeFeeCollector(pm, address(0), sink, 500, 500);
        vm.expectRevert(bytes("ZERO_RECIPIENT"));
        new HydeFeeCollector(pm, hydeout, address(0), 500, 500);
        vm.expectRevert(bytes("ZERO_PM"));
        new HydeFeeCollector(MockPositionManager(address(0)), hydeout, sink, 500, 500);
    }

    /* ─────────────────────── INV-1/18/19: 90/5/5 + LT burn ─────────────────── */
    function test_collect_splits_90_5_5_and_burns_LT_leg() public {
        uint128 fee0 = 1_000e18; // LT fees
        uint128 fee1 = 500e6; // numéraire fees
        pm.setPosition(TOKEN_ID, address(lt), address(num), fee0, fee1);
        num.mint(address(pm), fee1); // pm already holds LT supply; fund it with N

        uint256 supplyBefore = lt.totalSupply();
        collector.collect(address(lt));

        // LT leg: hydeout 5% transferred, buyback 5% BURNED (supply↓), creator 90% transferred
        uint256 h0 = (uint256(fee0) * 500) / 10_000;
        uint256 b0 = (uint256(fee0) * 500) / 10_000;
        assertEq(lt.balanceOf(hydeout), h0);
        assertEq(lt.balanceOf(creator), fee0 - h0 - b0);
        assertEq(lt.totalSupply(), supplyBefore - b0); // burned, not sent to sink
        assertEq(lt.balanceOf(sink), 0); // LT buyback never touches the sink
        assertEq(lt.balanceOf(address(collector)), 0); // nothing stranded

        // Numéraire leg: hydeout 5%, buyback 5% → SINK (no burn), creator 90%
        uint256 h1 = (uint256(fee1) * 500) / 10_000;
        uint256 b1 = (uint256(fee1) * 500) / 10_000;
        assertEq(num.balanceOf(hydeout), h1);
        assertEq(num.balanceOf(sink), b1);
        assertEq(num.balanceOf(creator), fee1 - h1 - b1);
        assertEq(num.balanceOf(address(collector)), 0);
    }

    function testFuzz_split_exact_three_way(uint128 fee0, uint128 fee1) public {
        fee0 = uint128(bound(fee0, 0, SUPPLY)); // pm holds SUPPLY of LT
        pm.setPosition(TOKEN_ID, address(lt), address(num), fee0, fee1);
        num.mint(address(pm), fee1);

        uint256 supplyBefore = lt.totalSupply();
        collector.collect(address(lt));

        // LT: creator + hydeout + burned == fee0 (burned == supply delta), hydeout exact, creator ≥ 90%
        uint256 burned = supplyBefore - lt.totalSupply();
        assertEq(lt.balanceOf(creator) + lt.balanceOf(hydeout) + burned, fee0);
        assertEq(lt.balanceOf(hydeout), (uint256(fee0) * 500) / 10_000);
        assertEq(burned, (uint256(fee0) * 500) / 10_000);
        assertGe(lt.balanceOf(creator) * 100, uint256(fee0) * 90);

        // N: creator + hydeout + sink == fee1, both 5% legs exact
        assertEq(num.balanceOf(creator) + num.balanceOf(hydeout) + num.balanceOf(sink), fee1);
        assertEq(num.balanceOf(hydeout), (uint256(fee1) * 500) / 10_000);
        assertEq(num.balanceOf(sink), (uint256(fee1) * 500) / 10_000);
    }

    function test_collect_unknown_reverts() public {
        vm.expectRevert(bytes("UNKNOWN"));
        collector.collect(address(0xdeadbeef));
    }

    /* ─────────────────────── graduate disabled (kami 21162.4) ──────────────── */
    function test_graduate_is_disabled() public {
        vm.expectRevert(bytes("GRADUATION_PENDING"));
        collector.graduate(address(lt));
    }

    /* ─────────────── INV-14 (partial, pre-fork): no custody/approval selectors ─────────── */
    /// @notice Explicit ABI allowlist proof — the collector exposes NONE of the selectors that could
    ///         move the position or grant an approval. Each low-level call must fail (no such function,
    ///         no fallback). Full "NFT never leaves" custody is verified on the real V3 fork.
    function test_collector_exposes_no_custody_selectors() public {
        bytes[] memory forbidden = new bytes[](9);
        forbidden[0] = abi.encodeWithSignature("approve(address,uint256)", address(0xBEEF), TOKEN_ID);
        forbidden[1] = abi.encodeWithSignature("setApprovalForAll(address,bool)", address(0xBEEF), true);
        forbidden[2] = abi.encodeWithSignature(
            "transferFrom(address,address,uint256)", address(collector), address(0xBEEF), TOKEN_ID
        );
        forbidden[3] = abi.encodeWithSignature(
            "safeTransferFrom(address,address,uint256)", address(collector), address(0xBEEF), TOKEN_ID
        );
        forbidden[4] = abi.encodeWithSignature(
            "decreaseLiquidity(uint256,uint128,uint256,uint256,uint256)", TOKEN_ID, uint128(1), 0, 0, block.timestamp
        );
        forbidden[5] = abi.encodeWithSignature("burn(uint256)", TOKEN_ID);
        forbidden[6] = abi.encodeWithSignature("withdraw(uint256)", TOKEN_ID);
        forbidden[7] = abi.encodeWithSignature("execute(address,bytes)", address(lt), "");
        forbidden[8] = abi.encodeWithSignature("multicall(bytes[])", new bytes[](0));

        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = address(collector).call(forbidden[i]);
            assertFalse(ok, "forbidden custody/approval selector is callable");
        }
    }
}
