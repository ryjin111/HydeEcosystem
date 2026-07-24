// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {HydeERC20} from "./HydeERC20.sol";
import {HydeV3FeeLocker} from "./HydeV3FeeLocker.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IV3PositionManagerMint} from "./interfaces/IUniswapV3Minimal.sol";
import {IV3PositionManagerCollect} from "./interfaces/IUniswapV3Minimal.sol";
import {TickMath} from "./libraries/TickMath.sol";

/// @title HydeV3Pad — permissionless single-sided V3 launchpad (Hydeout multichain reach line)
/// @notice `_launch`: pay flat launch fee → clone a fair-launch `HydeERC20` → create + initialize a
///         token/numeraire V3 pool at a preset tick boundary → mint the ENTIRE 1e9 supply as SINGLE-SIDED
///         (token-only, ZERO numeraire) liquidity straight into the perma-lock `HydeV3FeeLocker`. Price
///         walks up from the floor FDV as buyers trade. No bonding curve, no hook, no oracle. Correct for
///         BOTH token/numeraire orderings.
///
///         🚨 DECIMALS: config supplies `startFdvWad`/`topFdvWad` DECIMALS-INDEPENDENT (whole-numeraire
///         FDV × 1e18); the constructor scales them to numeraire-raw ON-CHAIN via
///         `mulDiv(fdvWad, 10^NUMERAIRE_DECIMALS, 1e18)` (mul-before-div), so the immutable
///         `NUMERAIRE_DECIMALS` is LOAD-BEARING — a mis-scaled decimals config can't silently seed.
///         `_sqrtPriceX96FromFdv` itself stays decimals-agnostic (pure raw ratio). `TOTAL_SUPPLY` is
///         token-raw (1e27, token is 18-dec). A 6-dec numeraire (USDT0) yields a 10^12-smaller `fdvRaw`
///         → the correct sub-cent price instead of a $1.9T pool. Never reads `decimals()`/`symbol()` on
///         the numeraire at runtime.
contract HydeV3Pad is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------ constants --
    /// @dev token-raw supply: 1e9 whole tokens × 1e18 (HydeERC20 is 18-dec). Matches HydeERC20.TOTAL_SUPPLY.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant MAX_SALT_TRIES = 64;

    // ----------------------------------------------------------- immutables --
    address public immutable IMPL; // pre-deployed HydeERC20 implementation (EIP-1167 cloned per launch)
    HydeV3FeeLocker public immutable LOCKER; // custodies + splits; deployed in ctor
    IUniswapV3Factory public immutable V3_FACTORY;
    IV3PositionManagerMint public immutable POSITION_MANAGER;

    address public immutable NUMERAIRE; // the paired asset (USDT0 on Stable) — pool currency0/1 per sort
    uint8 public immutable NUMERAIRE_DECIMALS; // IMMUTABLE from verified config — NEVER an on-chain read
    uint24 public immutable FEE_TIER;
    int24 public immutable TICK_SPACING;

    // Launch fee (distinct from the 95/5 trading split). ERC-20 path (approve+transferFrom) with an
    // exact-delta fee-on-transfer guard; or native (msg.value) where the chain's fee asset is native.
    address public immutable LAUNCH_FEE_ASSET; // fee token; address(0) iff native
    uint256 public immutable LAUNCH_FEE_AMOUNT;
    bool public immutable LAUNCH_FEE_NATIVE;
    address public immutable LAUNCH_FEE_TREASURY;

    // Anti-snipe params handed to every launched HydeERC20 (token-side max-wallet only).
    uint256 public immutable MAX_WALLET_BPS;
    uint64 public immutable MAX_WALLET_WINDOW_SECS;

    // Preset range (token0-convention), derived once from the FDV targets, tickSpacing-aligned.
    int24 public immutable TICK_FLOOR; // launch/open price
    int24 public immutable TICK_CEIL; // range ceiling
    uint256 public immutable ACTUAL_START_FDV_RAW; // realized floor FDV (numeraire-raw) after alignment
    uint256 public immutable ACTUAL_TOP_FDV_RAW;

    // -------------------------------------------------------------- storage --
    mapping(address => bool) public isHydeToken;
    address[] public allTokens;
    uint256 public launchNonce;

    // --------------------------------------------------------------- events --
    event LaunchFeePaid(address indexed creator, address indexed asset, uint256 amount);
    event LaunchCreated(
        address indexed token, address indexed creator, address pool, uint256 tokenId, uint128 liquidity
    );

    // --------------------------------------------------------------- errors --
    error InvalidConfig();
    error BadFee();
    error FeeOnTransfer();
    error EthFeeTransferFailed();
    error LaunchGriefed();
    error NotSingleSided();
    error SeedFailed();
    error TickRangeInvalid();
    error NotCustodied();

    struct Config {
        address impl;
        address v3Factory;
        address positionManager;
        address hydeTreasury; // 5% fee recipient (passed to the locker)
        address numeraire;
        uint8 numeraireDecimals;
        uint24 feeTier;
        uint256 startFdvWad; // FDV floor, DECIMALS-INDEPENDENT (FDV × 1e18); scaled on-chain by NUMERAIRE_DECIMALS
        uint256 topFdvWad; // FDV ceiling (× 1e18)
        address launchFeeAsset; // address(0) iff native
        uint256 launchFeeAmount;
        bool launchFeeNative;
        address launchFeeTreasury;
        uint256 maxWalletBps; // token-side anti-snipe cap (0<bps<=300)
        uint64 maxWalletWindowSecs; // (0<secs<=3600)
        uint256 graduationThreshold; // cumulative numeraire-fee target for the cosmetic graduation label (raw units)
    }

    constructor(Config memory c) {
        if (
            c.impl == address(0) || c.v3Factory == address(0) || c.positionManager == address(0)
                || c.hydeTreasury == address(0) || c.numeraire == address(0) || c.launchFeeTreasury == address(0)
                || c.startFdvWad == 0 || c.topFdvWad <= c.startFdvWad
                // graduationThreshold must be > 0: a 0 threshold would auto-flip the cosmetic "graduated"
                // label at launch for every token. Fail-closed, same as startFdvWad.
                || c.graduationThreshold == 0
        ) revert InvalidConfig();
        // Fee config coherence: native ⇒ no asset; ERC-20 ⇒ asset set. Amount must be non-zero (never free).
        if (c.launchFeeAmount == 0) revert InvalidConfig();
        if (c.launchFeeNative) {
            if (c.launchFeeAsset != address(0)) revert InvalidConfig();
        } else {
            if (c.launchFeeAsset == address(0)) revert InvalidConfig();
        }

        IMPL = c.impl;
        V3_FACTORY = IUniswapV3Factory(c.v3Factory);
        POSITION_MANAGER = IV3PositionManagerMint(c.positionManager);
        NUMERAIRE = c.numeraire;
        NUMERAIRE_DECIMALS = c.numeraireDecimals;
        FEE_TIER = c.feeTier;
        LAUNCH_FEE_ASSET = c.launchFeeAsset;
        LAUNCH_FEE_AMOUNT = c.launchFeeAmount;
        LAUNCH_FEE_NATIVE = c.launchFeeNative;
        LAUNCH_FEE_TREASURY = c.launchFeeTreasury;
        MAX_WALLET_BPS = c.maxWalletBps;
        MAX_WALLET_WINDOW_SECS = c.maxWalletWindowSecs;

        int24 spacing = V3_FACTORY.feeAmountTickSpacing(c.feeTier);
        if (spacing == 0) revert InvalidConfig(); // fee tier not enabled on this factory
        TICK_SPACING = spacing;

        // Derive the token0-convention range from the FDV targets, aligned to spacing. Only the sign flips
        // at launch for the token1 ordering. DECIMALS-CORRECT + hardened: scale the decimals-
        // independent FDV wad → numeraire-raw ON-CHAIN using the immutable NUMERAIRE_DECIMALS, so a mis-scaled
        // config can't silently seed. `_sqrtPriceX96FromFdv` itself stays decimals-agnostic (pure raw ratio).
        uint256 numScale = 10 ** c.numeraireDecimals;
        uint256 startFdvRaw = Math.mulDiv(c.startFdvWad, numScale, 1e18);
        uint256 topFdvRaw = Math.mulDiv(c.topFdvWad, numScale, 1e18);
        int24 rawFloor = TickMath.getTickAtSqrtRatio(_sqrtPriceX96FromFdv(startFdvRaw));
        int24 rawCeil = TickMath.getTickAtSqrtRatio(_sqrtPriceX96FromFdv(topFdvRaw));
        int24 floor_ = _alignToSpacing(rawFloor);
        int24 ceil_ = _alignToSpacing(rawCeil);
        if (floor_ >= ceil_) revert TickRangeInvalid();
        TICK_FLOOR = floor_;
        TICK_CEIL = ceil_;
        ACTUAL_START_FDV_RAW = _fdvRawFromSqrtPriceX96(TickMath.getSqrtRatioAtTick(floor_));
        ACTUAL_TOP_FDV_RAW = _fdvRawFromSqrtPriceX96(TickMath.getSqrtRatioAtTick(ceil_));

        // The locker's FACTORY is this pad; it collects via the COLLECT-only surface (perma-lock).
        LOCKER = new HydeV3FeeLocker(
            address(this), IV3PositionManagerCollect(c.positionManager), c.hydeTreasury, c.graduationThreshold
        );
    }

    // -------------------------------------------------------------- launch --

    /// @notice Permissionless launch. `creator := msg.sender`. All-or-revert. Pass a fresh RANDOM `salt`
    ///         each call (griefing guard) — retry on {LaunchGriefed}.
    function launch(string calldata name, string calldata symbol, bytes32 salt)
        external
        payable
        nonReentrant
        returns (address token, uint256 tokenId)
    {
        address creator = msg.sender;

        // 1. Fee FIRST — atomic, before any deploy. Chain-gate: never free.
        _takeLaunchFee(creator);

        // 2. Clone HydeERC20 at a clean CREATE2 address (no pre-existing pool, no code), probing salts.
        bytes32 seed = keccak256(abi.encode(creator, salt, launchNonce++));
        uint256 tries;
        for (; tries < MAX_SALT_TRIES;) {
            address predicted = Clones.predictDeterministicAddress(IMPL, seed, address(this));
            if (
                predicted.code.length == 0
                    && V3_FACTORY.getPool(predicted, NUMERAIRE, FEE_TIER) == address(0)
            ) break;
            unchecked {
                ++tries;
                seed = keccak256(abi.encode(seed));
            }
        }
        if (tries == MAX_SALT_TRIES) revert LaunchGriefed();

        token = Clones.cloneDeterministic(IMPL, seed);

        // 3. Create the pool FIRST (before token init) so its address can be max-wallet-exempt — it
        //    receives ~100% of supply via the single-sided mint, which would otherwise trip MAX_WALLET
        //    (surfacing as Uniswap `STF`). createPool needs only the token ADDRESS, not an initialized token.
        bool tokenIs0 = token < NUMERAIRE;
        (int24 tickLower, int24 tickUpper, int24 initTick) = _rangeFor(tokenIs0);
        address pool = V3_FACTORY.getPool(token, NUMERAIRE, FEE_TIER);
        if (pool == address(0)) pool = V3_FACTORY.createPool(token, NUMERAIRE, FEE_TIER);

        // 4. Init the clone with the pool in the exempt set; mint 100% supply to THIS pad (exempt seeder).
        address[] memory exemptAddrs = new address[](5);
        exemptAddrs[0] = address(this); // factory / seeder
        exemptAddrs[1] = pool; // custodies ~all supply from the single-sided mint — MUST be exempt
        exemptAddrs[2] = address(POSITION_MANAGER);
        exemptAddrs[3] = address(LOCKER);
        exemptAddrs[4] = address(V3_FACTORY);
        HydeERC20(token).initialize(
            HydeERC20.InitParams({
                name: name,
                symbol: symbol,
                poolRecipient: address(this),
                feeLocker: address(LOCKER),
                maxWalletBps: MAX_WALLET_BPS,
                maxWalletWindowSecs: MAX_WALLET_WINDOW_SECS,
                exemptAddrs: exemptAddrs
            })
        );

        // 5. Initialize the pool at the preset tick boundary (zero-numeraire single-sided mint), then mint.
        (uint160 existing,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (existing == 0) IUniswapV3Pool(pool).initialize(TickMath.getSqrtRatioAtTick(initTick));

        uint128 liquidity;
        (tokenId, liquidity) = _mintSingleSided(token, tokenIs0, tickLower, tickUpper);

        // 5. Custody proof: the position NFT landed in the locker.
        if (POSITION_MANAGER.ownerOf(tokenId) != address(LOCKER)) revert NotCustodied();

        // 6. Register the locked position (creator immutable) + record.
        LOCKER.register(token, creator, tokenId, NUMERAIRE, FEE_TIER);
        isHydeToken[token] = true;
        allTokens.push(token);

        emit LaunchCreated(token, creator, pool, tokenId, liquidity);
    }

    // ---------------------------------------------------------- fee intake --

    function _takeLaunchFee(address creator) internal {
        if (LAUNCH_FEE_NATIVE) {
            if (msg.value != LAUNCH_FEE_AMOUNT) revert BadFee();
            (bool ok,) = LAUNCH_FEE_TREASURY.call{value: msg.value}("");
            if (!ok) revert EthFeeTransferFailed();
        } else {
            if (msg.value != 0) revert BadFee(); // no stray ETH on an ERC-20-fee chain
            IERC20 feeAsset = IERC20(LAUNCH_FEE_ASSET);
            uint256 before = feeAsset.balanceOf(LAUNCH_FEE_TREASURY);
            feeAsset.safeTransferFrom(creator, LAUNCH_FEE_TREASURY, LAUNCH_FEE_AMOUNT);
            // Exact-delta guard: a fee-on-transfer asset would deliver < amount → reject (never underfund).
            if (feeAsset.balanceOf(LAUNCH_FEE_TREASURY) - before != LAUNCH_FEE_AMOUNT) revert FeeOnTransfer();
        }
        emit LaunchFeePaid(creator, LAUNCH_FEE_ASSET, LAUNCH_FEE_AMOUNT);
    }

    // ---------------------------------------------------------- LP seeding --

    /// @dev Mints the pad's entire token balance as single-sided (token-only) liquidity straight to the
    ///      locker, and asserts ZERO numeraire was consumed (a mis-set range needing numeraire ⇒ revert).
    function _mintSingleSided(address token, bool tokenIs0, int24 tickLower, int24 tickUpper)
        internal
        returns (uint256 tokenId, uint128 liquidity)
    {
        uint256 supply = IERC20(token).balanceOf(address(this));
        IERC20(token).forceApprove(address(POSITION_MANAGER), supply);

        (uint256 amt0Desired, uint256 amt1Desired) =
            tokenIs0 ? (supply, uint256(0)) : (uint256(0), supply);

        uint256 used0;
        uint256 used1;
        (tokenId, liquidity, used0, used1) = POSITION_MANAGER.mint(
            IV3PositionManagerMint.MintParams({
                token0: tokenIs0 ? token : NUMERAIRE,
                token1: tokenIs0 ? NUMERAIRE : token,
                fee: FEE_TIER,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amt0Desired,
                amount1Desired: amt1Desired,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(LOCKER),
                deadline: block.timestamp
            })
        );

        IERC20(token).forceApprove(address(POSITION_MANAGER), 0);

        uint256 numeraireUsed = tokenIs0 ? used1 : used0;
        uint256 tokenUsed = tokenIs0 ? used0 : used1;
        if (numeraireUsed != 0) revert NotSingleSided(); // must be pure token
        if (liquidity == 0 || tokenUsed < supply - supply / 1000) revert SeedFailed(); // ~full supply seeded
    }

    // ------------------------------------------------------------ tick math --

    /// @dev Range for a launch given token/numeraire ordering. token==token0 iff token < numeraire. For
    ///      token0 the range sits ABOVE the open (open at floor); for token1 the price is inverted, range
    ///      sits below, open at the ceiling — both single-sided in the TOKEN, zero numeraire seeded.
    function _rangeFor(bool tokenIs0)
        internal
        view
        returns (int24 tickLower, int24 tickUpper, int24 initTick)
    {
        if (tokenIs0) {
            return (TICK_FLOOR, TICK_CEIL, TICK_FLOOR);
        } else {
            return (-TICK_CEIL, -TICK_FLOOR, -TICK_FLOOR);
        }
    }

    /// @dev sqrtPriceX96 for a token0-convention price of `fdvRaw / TOTAL_SUPPLY` (numeraire-raw per
    ///      token-raw). DECIMALS-CORRECT: `fdvRaw` is in numeraire-raw units (scaled by the immutable
    ///      NUMERAIRE_DECIMALS in config); TOTAL_SUPPLY is token-raw (1e27). Decimals-parameterized, so a
    ///      6-dec numeraire seeds correctly rather than assuming an 18/18 pair.
    function _sqrtPriceX96FromFdv(uint256 fdvRaw) internal pure returns (uint160) {
        uint256 ratioX192 = Math.mulDiv(fdvRaw, 1 << 192, TOTAL_SUPPLY);
        return uint160(Math.sqrt(ratioX192));
    }

    /// @dev Inverse: FDV (numeraire-raw) implied by a token0-convention sqrtPriceX96.
    function _fdvRawFromSqrtPriceX96(uint160 sqrtPriceX96) internal pure returns (uint256) {
        uint256 p = uint256(sqrtPriceX96);
        return Math.mulDiv(p * p, TOTAL_SUPPLY, 1 << 192);
    }

    function _alignToSpacing(int24 tick) internal view returns (int24) {
        int24 spacing = TICK_SPACING;
        int24 q = tick / spacing;
        int24 r = tick % spacing;
        if (r >= spacing / 2) {
            q += 1;
        } else if (r <= -spacing / 2) {
            q -= 1;
        }
        return q * spacing;
    }

    // ---------------------------------------------------------------- views --
    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @dev Deterministic address of the next-clone probe base (frontends can predict).
    function predictToken(address creator, bytes32 salt, uint256 nonce) external view returns (address) {
        return Clones.predictDeterministicAddress(IMPL, keccak256(abi.encode(creator, salt, nonce)), address(this));
    }
}
