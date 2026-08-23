// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {HydeERC20} from "../../src/v3/HydeERC20.sol";
import {TickMath} from "../../src/v3/libraries/TickMath.sol";
import {TrenchV3Factory} from "../../src/v5v3/TrenchV3Factory.sol";
import {TrenchV3Graduator} from "../../src/v5v3/TrenchV3Graduator.sol";
import {TrenchV3Locker} from "../../src/v5v3/TrenchV3Locker.sol";
import {FlywheelVaultFactory} from "../../src/flywheel/FlywheelVaultFactory.sol";
import {MockERC20} from "../v3/mocks/MockERC20.sol";
import {MockTrenchV3Factory, MockTrenchV3Pool, MockTrenchV3PositionManager} from "./mocks/MockTrenchV3.sol";

contract TrenchV3InvariantHandler is Test {
    MockERC20 internal immutable quote;
    MockTrenchV3PositionManager internal immutable positionManager;
    TrenchV3Locker internal immutable locker;
    address internal immutable token;
    bool internal immutable tokenIs0;
    uint256[] internal permanentIds;

    constructor(
        MockERC20 quote_,
        MockTrenchV3PositionManager positionManager_,
        TrenchV3Locker locker_,
        address token_,
        uint256[] memory permanentIds_
    ) {
        quote = quote_;
        positionManager = positionManager_;
        locker = locker_;
        token = token_;
        tokenIs0 = token_ < address(quote_);
        permanentIds = permanentIds_;
    }

    function accrueQuoteFees(uint128 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000_000e6);
        quote.mint(address(positionManager), amount);
        positionManager.setFees(permanentIds[0], tokenIs0 ? 0 : amount, tokenIs0 ? amount : 0);
        locker.collect(token);
    }

    function collectPermanentFees() external {
        locker.collect(token);
    }

    function claimFixedRecipients() external {
        locker.claimCreator(token, address(quote));
        locker.claimHyde(token, address(quote));
    }

    function donateQuote(uint128 rawAmount) external {
        quote.mint(address(locker), bound(uint256(rawAmount), 1, 1_000_000_000e6));
    }
}

contract TrenchV3InvariantTest is StdInvariant, Test {
    uint24 internal constant FEE = 10_000;
    int24 internal constant SPACING = 200;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant HYDE = address(0x5EED);
    address internal constant LAUNCH_TREASURY = address(0x1A0C);

    MockERC20 internal quote;
    MockTrenchV3PositionManager internal positionManager;
    TrenchV3Factory internal factory;
    TrenchV3Graduator internal graduator;
    TrenchV3Locker internal locker;
    address internal token;
    uint256 internal curveTokenId;
    uint256[] internal permanentIds;
    uint128[] internal initialLiquidities;

    function setUp() public {
        quote = new MockERC20("USDT0", "USDT0", 6);
        MockTrenchV3Factory uniFactory = new MockTrenchV3Factory();
        uniFactory.setSpacing(FEE, SPACING);
        positionManager = new MockTrenchV3PositionManager(uniFactory);
        factory = new TrenchV3Factory(
            TrenchV3Factory.Config({
                impl: address(new HydeERC20()),
                v3Factory: address(uniFactory),
                positionManager: address(positionManager),
                flywheelVaultFactory: address(new FlywheelVaultFactory(address(this))),
                hydeTreasury: HYDE,
                numeraire: address(quote),
                numeraireDecimals: 6,
                feeTier: FEE,
                startFdvWad: 5_000e18,
                graduationFdvWad: 50_000e18,
                launchFeeAsset: address(quote),
                launchFeeAmount: 1e6,
                launchFeeNative: false,
                launchFeeTreasury: LAUNCH_TREASURY,
                maxWalletBps: 200,
                maxWalletWindowSecs: 60,
                observationCardinality: 16,
                graduationDelay: 300,
                twapTickTolerance: SPACING,
                minimumProceeds: 1,
                maxCurveDust: 10e18,
                maxPermanentTokenDust: 100e18,
                maxPermanentQuoteDust: 1_000,
                owner: address(this)
            })
        );
        graduator = factory.GRADUATOR();
        locker = factory.LOCKER();
        quote.mint(CREATOR, 10e6);
        vm.startPrank(CREATOR);
        quote.approve(address(factory), type(uint256).max);
        bytes32 salt = _findSalt(true);
        (token, curveTokenId) = factory.launch("Invariant Token", "INVAR", salt);
        vm.stopPrank();

        address poolAddress = uniFactory.getPool(token, address(quote), FEE);
        TrenchV3Graduator.Curve memory curve = graduator.curveInfo(token);
        int24 terminalTick = curve.tokenIs0 ? curve.tickUpper : curve.tickLower;
        MockTrenchV3Pool(poolAddress).setSlot0(TickMath.getSqrtRatioAtTick(terminalTick), terminalTick);
        TrenchV3Graduator.CurveProgress memory full = graduator.curveProgress(token);
        quote.mint(address(positionManager), full.quotePrincipal + 1_000e6);
        graduator.signalGraduation(token);
        vm.warp(block.timestamp + 301);
        permanentIds = graduator.finalizeGraduation(token, block.timestamp + 1 hours);
        for (uint256 i; i < permanentIds.length; ++i) {
            (,,,,,,, uint128 liquidity,,,,) = positionManager.positions(permanentIds[i]);
            initialLiquidities.push(liquidity);
        }

        TrenchV3InvariantHandler handler =
            new TrenchV3InvariantHandler(quote, positionManager, locker, token, permanentIds);
        targetContract(address(handler));
    }

    function invariant_permanent_liquidity_never_leaves_or_decreases() public view {
        for (uint256 i; i < permanentIds.length; ++i) {
            assertEq(positionManager.ownerOf(permanentIds[i]), address(locker));
            (,,,,,,, uint128 liquidity,,,,) = positionManager.positions(permanentIds[i]);
            assertGe(liquidity, initialLiquidities[i]);
        }
    }

    function invariant_supply_is_fixed_and_factory_holds_no_tokens() public view {
        assertEq(HydeERC20(token).totalSupply(), factory.TOTAL_SUPPLY());
        assertEq(HydeERC20(token).balanceOf(address(factory)), 0);
    }

    function invariant_progress_is_bounded() public view {
        TrenchV3Graduator.CurveProgress memory progress = graduator.curveProgress(token);
        assertEq(progress.sold, progress.curveAllocation);
        assertEq(progress.progressWad, 1e18);
        assertEq(uint256(progress.state), uint256(TrenchV3Graduator.CurveState.GRADUATED));
        assertEq(HydeERC20(token).balanceOf(address(graduator)), 0);
        assertEq(quote.balanceOf(address(graduator)), 0);
    }

    function invariant_temporary_curve_nft_stays_burned() public {
        vm.expectRevert(bytes("NOT_MINTED"));
        positionManager.ownerOf(curveTokenId);
    }

    function invariant_fee_liabilities_are_solvable() public view {
        uint256 creator = locker.creatorClaimable(token, address(quote));
        uint256 hyde = locker.hydeClaimable(token, address(quote));
        uint256 accounted = locker.accountedBalance(address(quote));
        assertEq(creator + hyde, accounted);
        assertLe(accounted, quote.balanceOf(address(locker)));
    }

    function _findSalt(bool wantToken0) private view returns (bytes32 salt) {
        for (uint256 i; i < 1_000; ++i) {
            salt = keccak256(abi.encode("V3_INVARIANT", i));
            address predicted = factory.predictToken(CREATOR, salt, factory.launchNonce());
            if ((predicted < address(quote)) == wantToken0) return salt;
        }
        revert("SALT_NOT_FOUND");
    }
}
