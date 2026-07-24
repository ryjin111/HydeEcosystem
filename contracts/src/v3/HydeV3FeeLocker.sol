// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IV3PositionManagerCollect} from "./interfaces/IUniswapV3Minimal.sol";

/// @title HydeV3FeeLocker — perma-lock custody + 95/5 in-kind fee split (Hydeout V3 reach line)
/// @notice Custodies the single-sided V3 LP position NFT minted at launch and NEVER lets its principal
///         leave.
///
///         PERMA-LOCK: this contract imports only {IV3PositionManagerCollect}, which declares NO
///         `decreaseLiquidity` / `burn` / `transferFrom` / `safeTransferFrom` / `approve` /
///         `setApprovalForAll`. Those selectors therefore CANNOT compile into the locker — the position
///         is locked by structural absence, provable by ABI selector-enumeration. The only thing
///         extractable is swap fees, via {collect}.
///
///         95/5 SPLIT: {collect} harvests owed fees in BOTH pool currencies (the launched token AND the
///         numeraire) and splits EACH leg independently — 95% to the immutable creator, 5% to the
///         immutable Hyde treasury. In-kind (no settle swap, no oracle). Fixed recipients, permissionless
///         push: anyone can crank {collect}; nobody can redirect a live position's fees (no owner, no
///         setter).
contract HydeV3FeeLocker is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice 95/5 split. HYDE_BPS + creator (implicit remainder) == 10000 exactly.
    uint256 public constant HYDE_BPS = 500; // 5% to Hyde treasury; creator gets the 9500 remainder + dust
    uint256 internal constant BPS = 10_000;

    /// @notice The `HydeV3Pad` factory — the only contract permitted to {register} a launch.
    address public immutable FACTORY;
    /// @notice Position manager, COLLECT-ONLY surface (perma-lock — see contract notice).
    IV3PositionManagerCollect public immutable POSITION_MANAGER;
    /// @notice Immutable 5% recipient. Fixed at deploy — no setter.
    address public immutable HYDE_TREASURY;
    /// @notice Cumulative numeraire-fee target that flips the COSMETIC graduation label (raw units, e.g.
    ///         500e6 = 500 USDT0). Label-only — graduation unlocks/migrates NOTHING (LP is perma-locked).
    ///         Self-fundable on vanilla V3 (flash-donatable fees) → a milestone signal, never traction proof.
    uint256 public immutable GRADUATION_THRESHOLD;

    struct Position {
        address creator; // immutable 95% recipient, fixed at register — no redirect
        address token0; // pool currency0 (launched token or numeraire, per sort)
        address token1; // pool currency1
        address numeraire; // the paired asset — the graduation metric accrues on THIS leg
        uint256 tokenId; // the locked V3 position NFT
        uint24 feeTier;
        uint256 cumulativeNumeraireFees; // monotonic; graduation label flips at GRADUATION_THRESHOLD
        bool graduated;
        bool registered;
    }

    /// @notice launched token => its locked position + split terms.
    mapping(address => Position) public positionOf;

    event PositionLocked(address indexed token, address indexed creator, uint256 indexed tokenId);
    event FeesCollected(address indexed token, address indexed caller, uint256 amount0, uint256 amount1);
    event FeeSplit(address indexed asset, address indexed creator, uint256 creatorCut, uint256 hydeCut);
    event Graduated(address indexed token);

    error OnlyFactory();
    error AlreadyRegistered();
    error UnknownPosition();
    error ZeroAddress();
    error NotCustodied();
    error GraduationPending();
    error AlreadyGraduated();

    constructor(
        address factory_,
        IV3PositionManagerCollect positionManager_,
        address hydeTreasury_,
        uint256 graduationThreshold_
    ) {
        if (factory_ == address(0) || address(positionManager_) == address(0) || hydeTreasury_ == address(0)) {
            revert ZeroAddress();
        }
        FACTORY = factory_;
        POSITION_MANAGER = positionManager_;
        HYDE_TREASURY = hydeTreasury_;
        GRADUATION_THRESHOLD = graduationThreshold_;
    }

    /// @notice Registers a freshly-minted, single-sided position. Factory-only. The NFT MUST already be
    ///         owned by this locker (the factory mints it here) — asserted, so a launch can never register
    ///         a position custodied elsewhere. Creator + terms are immutable thereafter.
    function register(address token, address creator, uint256 tokenId, address numeraire, uint24 feeTier)
        external
    {
        if (msg.sender != FACTORY) revert OnlyFactory();
        if (positionOf[token].registered) revert AlreadyRegistered();
        if (creator == address(0) || token == address(0)) revert ZeroAddress();
        // Custody proof: the position NFT is already ours (minted straight to this locker at seed).
        if (POSITION_MANAGER.ownerOf(tokenId) != address(this)) revert NotCustodied();

        (,, address t0, address t1,,,,,,,,) = POSITION_MANAGER.positions(tokenId);
        positionOf[token] = Position({
            creator: creator,
            token0: t0,
            token1: t1,
            numeraire: numeraire,
            tokenId: tokenId,
            feeTier: feeTier,
            cumulativeNumeraireFees: 0,
            graduated: false,
            registered: true
        });
        emit PositionLocked(token, creator, tokenId);
    }

    /// @notice Harvest owed swap fees for `token`'s locked position and split BOTH legs 95/5. Permissionless
    ///         (anyone can crank); the payout always goes to the FIXED creator + Hyde treasury regardless of
    ///         caller. Swap-free, oracle-free. `nonReentrant`; the split's only external calls are ERC-20
    ///         transfers to fixed EOAs/treasury and the launched token has no transfer hook.
    function collect(address token) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        Position memory pos = positionOf[token];
        if (!pos.registered) revert UnknownPosition();

        (amount0, amount1) = POSITION_MANAGER.collect(
            IV3PositionManagerCollect.CollectParams({
                tokenId: pos.tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        // Split EACH leg independently — both the launched-token side and the numeraire side.
        _split(pos.token0, pos.creator, amount0);
        _split(pos.token1, pos.creator, amount1);

        // Accrue the numeraire-leg fees toward the cosmetic graduation milestone (monotonic — never resets).
        uint256 numeraireFee = pos.numeraire == pos.token0 ? amount0 : amount1;
        if (numeraireFee != 0) positionOf[token].cumulativeNumeraireFees += numeraireFee;

        emit FeesCollected(token, msg.sender, amount0, amount1);
    }

    /// @dev 95/5 split of one collected asset leg. `hydeCut` is floored (round-down); `creatorCut` takes
    ///      the exact remainder so `creatorCut + hydeCut == amount` — never pays out more than collected,
    ///      nothing stranded. Direct push to the two immutable recipients; a failed leg reverts the whole
    ///      collect (no partial split, no accrual buffer). Both assets are config-gated well-behaved
    ///      ERC-20s (launched HydeERC20 + the verified numeraire), so the transfers do not brick.
    function _split(address asset, address creator, uint256 amount) internal {
        if (amount == 0) return;
        uint256 hydeCut = (amount * HYDE_BPS) / BPS; // 5%, floored
        uint256 creatorCut = amount - hydeCut; // 95% + rounding dust
        IERC20(asset).safeTransfer(creator, creatorCut);
        IERC20(asset).safeTransfer(HYDE_TREASURY, hydeCut);
        emit FeeSplit(asset, creator, creatorCut, hydeCut);
    }

    /// @notice Flip the COSMETIC graduation label once the token's cumulative numeraire fees reach
    ///         GRADUATION_THRESHOLD. Permissionless, one-way latch. LABEL ONLY — unlocks/migrates NOTHING
    ///         (liquidity is live + perma-locked from block 0). The metric is self-fundable on vanilla V3
    ///         (flash-donatable fees) → a milestone, not traction proof.
    function graduate(address token) external {
        Position storage pos = positionOf[token];
        if (!pos.registered) revert UnknownPosition();
        if (pos.graduated) revert AlreadyGraduated();
        if (pos.cumulativeNumeraireFees < GRADUATION_THRESHOLD) revert GraduationPending();
        pos.graduated = true;
        emit Graduated(token);
    }

    /// @notice UI progress marker: (accrued numeraire fees, threshold, graduated?).
    function graduationProgress(address token)
        external
        view
        returns (uint256 accrued, uint256 threshold, bool graduated)
    {
        Position storage pos = positionOf[token];
        return (pos.cumulativeNumeraireFees, GRADUATION_THRESHOLD, pos.graduated);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
