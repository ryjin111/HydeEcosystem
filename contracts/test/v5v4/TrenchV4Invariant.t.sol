// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {HydeERC20} from "../../src/HydeERC20.sol";
import {TrenchV4Graduator} from "../../src/v5v4/TrenchV4Graduator.sol";
import {TrenchV4Locker} from "../../src/v5v4/TrenchV4Locker.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {TrenchV4LifecycleTest} from "./TrenchV4Lifecycle.t.sol";

contract TrenchV4InvariantHandler is Test {
    MockERC20 private immutable _weth;
    TrenchV4Locker private immutable _locker;
    address private immutable _token;

    constructor(MockERC20 weth_, TrenchV4Locker locker_, address token_) {
        _weth = weth_;
        _locker = locker_;
        _token = token_;
    }

    function collectPermanentFees() external {
        _locker.collect(_token);
    }

    function claimFixedRecipients() external {
        _locker.claimCreator(_token, address(_weth));
        _locker.claimHyde(_token, address(_weth));
        _locker.claimCreator(_token, _token);
        _locker.claimHyde(_token, _token);
    }

    function donateNumeraire(uint96 rawAmount) external {
        _weth.mint(address(_locker), bound(uint256(rawAmount), 1, 1_000_000_000e18));
    }
}

contract TrenchV4InvariantTest is StdInvariant, TrenchV4LifecycleTest {
    address internal invariantToken;
    uint256 internal invariantCurveTokenId;
    uint256[] internal permanentIds;
    uint128[] internal initialLiquidities;

    function setUp() public override {
        super.setUp();
        (invariantToken, invariantCurveTokenId) = _launch(true);
        TrenchV4Graduator.Curve memory curve = graduator.curveInfo(invariantToken);
        _moveToTerminal(invariantToken, curve);
        graduator.signalGraduation(invariantToken);
        vm.warp(block.timestamp + GRADUATION_DELAY);
        graduator.finalizeGraduation(invariantToken, block.timestamp + 1);

        (,,, uint256 count) = locker.positionInfo(invariantToken);
        for (uint256 i; i < count; ++i) {
            uint256 tokenId = locker.positionIdAt(invariantToken, i);
            permanentIds.push(tokenId);
            initialLiquidities.push(lpm.getPositionLiquidity(tokenId));
        }

        TrenchV4InvariantHandler handler = new TrenchV4InvariantHandler(weth, locker, invariantToken);
        targetContract(address(handler));
    }

    function invariant_permanentLiquidityNeverLeavesOrDecreases() public view {
        for (uint256 i; i < permanentIds.length; ++i) {
            assertEq(IERC721(address(lpm)).ownerOf(permanentIds[i]), address(locker));
            assertGe(lpm.getPositionLiquidity(permanentIds[i]), initialLiquidities[i]);
        }
    }

    function invariant_supplyIsFixedAndFactoryHoldsNoTokens() public view {
        assertEq(HydeERC20(invariantToken).totalSupply(), factory.TOTAL_SUPPLY());
        assertEq(HydeERC20(invariantToken).balanceOf(address(factory)), 0);
    }

    function invariant_progressIsBounded() public view {
        TrenchV4Graduator.CurveProgress memory progress = graduator.curveProgress(invariantToken);
        assertEq(progress.sold, progress.curveAllocation);
        assertEq(progress.progressWad, 1e18);
        assertEq(uint256(progress.state), uint256(TrenchV4Graduator.CurveState.GRADUATED));
        assertEq(HydeERC20(invariantToken).balanceOf(address(graduator)), 0);
        assertEq(weth.balanceOf(address(graduator)), 0);
    }

    function invariant_temporaryCurveNftStaysBurned() public {
        vm.expectRevert();
        IERC721(address(lpm)).ownerOf(invariantCurveTokenId);
    }

    function invariant_feeLiabilitiesAreSolvable() public view {
        _assertAssetSolvency(invariantToken);
        _assertAssetSolvency(address(weth));
    }

    function _assertAssetSolvency(address asset) private view {
        uint256 creator = locker.creatorClaimable(invariantToken, asset);
        uint256 hyde = locker.hydeClaimable(invariantToken, asset);
        uint256 autoLp = locker.pendingAutoLp(invariantToken, asset);
        uint256 compounded = locker.totalAutoLpCompounded(invariantToken, asset);
        uint256 liabilities = creator + hyde + autoLp;

        assertLe(liabilities, IERC20(asset).balanceOf(address(locker)));
        assertGe(locker.totalFeesAccounted(invariantToken, asset), liabilities + compounded);
    }
}
