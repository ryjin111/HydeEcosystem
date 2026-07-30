// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITrenchV3CollectOnly, TrenchV3CollectParams} from "./interfaces/ITrenchV3.sol";

/// @title TrenchV3Locker
/// @notice Permanent custody for every graduated V3 position. This contract deliberately imports
///         only the collect/read PositionManager surface: there is no decrease, burn, transfer,
///         approval, withdrawal, or arbitrary-call path.
contract TrenchV3Locker is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant HYDE_BPS = 500;
    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_POSITIONS = 3;

    ITrenchV3CollectOnly public immutable POSITION_MANAGER;
    address public immutable HYDE_TREASURY;

    address private immutable _deployer;
    address public graduator;

    struct LockedPosition {
        address creator;
        address token0;
        address token1;
        address numeraire;
        uint24 feeTier;
        bool curveOpened;
        bool positionsRegistered;
        uint256[] tokenIds;
    }

    mapping(address token => LockedPosition) private _positionOf;
    mapping(address token => mapping(address asset => uint256)) public creatorClaimable;
    mapping(address token => mapping(address asset => uint256)) public hydeClaimable;
    mapping(address asset => uint256) public accountedBalance;

    event GraduatorInitialized(address indexed graduator);
    event CurveOpened(address indexed token, address indexed creator, address indexed numeraire);
    event PositionsLocked(
        address indexed token, address indexed creator, uint256 indexed primaryTokenId, uint256 positionCount
    );
    event FeesCollected(address indexed token, address indexed caller, uint256 amount0, uint256 amount1);
    event FeeCredited(
        address indexed token, address indexed asset, address indexed creator, uint256 creatorCut, uint256 hydeCut
    );
    event CreatorClaimed(address indexed token, address indexed asset, address indexed creator, uint256 amount);
    event HydeClaimed(address indexed token, address indexed asset, address indexed treasury, uint256 amount);

    error OnlyDeployer();
    error OnlyGraduator();
    error AlreadyInitialized();
    error AlreadyRegistered();
    error InvalidRegistration();
    error NotCustodied();
    error UnknownPosition();

    constructor(ITrenchV3CollectOnly positionManager, address hydeTreasury) {
        require(address(positionManager) != address(0) && hydeTreasury != address(0), "ZERO_CONFIG");
        POSITION_MANAGER = positionManager;
        HYDE_TREASURY = hydeTreasury;
        _deployer = msg.sender;
    }

    /// @notice One-shot deployment-cycle binding. No setter exists after initialization.
    function initGraduator(address graduator_) external {
        if (msg.sender != _deployer) revert OnlyDeployer();
        if (graduator != address(0)) revert AlreadyInitialized();
        if (graduator_ == address(0)) revert InvalidRegistration();
        graduator = graduator_;
        emit GraduatorInitialized(graduator_);
    }

    function openCurve(address token, address creator, address numeraire, uint24 feeTier) external {
        if (msg.sender != graduator) revert OnlyGraduator();
        LockedPosition storage pos = _positionOf[token];
        if (pos.curveOpened) revert AlreadyRegistered();
        if (
            token == address(0) || creator == address(0) || numeraire == address(0) || token == numeraire
                || feeTier == 0
        ) {
            revert InvalidRegistration();
        }

        address expected0 = token < numeraire ? token : numeraire;
        address expected1 = token < numeraire ? numeraire : token;
        pos.creator = creator;
        pos.token0 = expected0;
        pos.token1 = expected1;
        pos.numeraire = numeraire;
        pos.feeTier = feeTier;
        pos.curveOpened = true;
        emit CurveOpened(token, creator, numeraire);
    }

    function registerPositions(address token, uint256[] calldata tokenIds) external {
        if (msg.sender != graduator) revert OnlyGraduator();
        LockedPosition storage pos = _positionOf[token];
        if (!pos.curveOpened || pos.positionsRegistered) revert AlreadyRegistered();
        if (tokenIds.length == 0 || tokenIds.length > MAX_POSITIONS) revert InvalidRegistration();
        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 tokenId = tokenIds[i];
            if (POSITION_MANAGER.ownerOf(tokenId) != address(this)) revert NotCustodied();
            (,, address token0, address token1, uint24 fee,,,,,,,) = POSITION_MANAGER.positions(tokenId);
            if (token0 != pos.token0 || token1 != pos.token1 || fee != pos.feeTier) {
                revert InvalidRegistration();
            }
            pos.tokenIds.push(tokenId);
        }
        pos.positionsRegistered = true;
        emit PositionsLocked(token, pos.creator, tokenIds[0], tokenIds.length);
    }

    /// @notice Pull curve fees from the graduator and credit immutable claim buckets.
    /// @dev Pull-and-measure prevents a direct donation from fabricating fee credit.
    function noteCurveFees(address token, address asset, uint256 amount) external nonReentrant {
        if (msg.sender != graduator) revert OnlyGraduator();
        LockedPosition storage pos = _positionOf[token];
        if (!pos.curveOpened || (asset != pos.token0 && asset != pos.token1)) revert InvalidRegistration();
        if (amount == 0) return;
        uint256 beforeBalance = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert InvalidRegistration();
        _credit(token, asset, pos.creator, received);
    }

    /// @notice Harvest every permanent NFT and split both asset legs 95/5.
    /// @dev Permissionless crank; caller never influences the fixed recipients.
    function collect(address token) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        LockedPosition storage pos = _positionOf[token];
        if (!pos.positionsRegistered) revert UnknownPosition();

        uint256 count = pos.tokenIds.length;
        for (uint256 i; i < count; ++i) {
            (uint256 got0, uint256 got1) = POSITION_MANAGER.collect(
                TrenchV3CollectParams({
                    tokenId: pos.tokenIds[i],
                    recipient: address(this),
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                })
            );
            amount0 += got0;
            amount1 += got1;
        }

        _credit(token, pos.token0, pos.creator, amount0);
        _credit(token, pos.token1, pos.creator, amount1);
        emit FeesCollected(token, msg.sender, amount0, amount1);
    }

    function _credit(address token, address asset, address creator, uint256 amount) private {
        if (amount == 0) return;
        uint256 hydeCut = (amount * HYDE_BPS) / BPS;
        uint256 creatorCut = amount - hydeCut;
        creatorClaimable[token][asset] += creatorCut;
        hydeClaimable[token][asset] += hydeCut;
        accountedBalance[asset] += amount;
        emit FeeCredited(token, asset, creator, creatorCut, hydeCut);
    }

    function claimCreator(address token, address asset) external nonReentrant returns (uint256 amount) {
        LockedPosition storage pos = _positionOf[token];
        if (!pos.curveOpened || (asset != pos.token0 && asset != pos.token1)) revert UnknownPosition();
        amount = creatorClaimable[token][asset];
        if (amount == 0) return 0;
        creatorClaimable[token][asset] = 0;
        accountedBalance[asset] -= amount;
        IERC20(asset).safeTransfer(pos.creator, amount);
        emit CreatorClaimed(token, asset, pos.creator, amount);
    }

    function claimHyde(address token, address asset) external nonReentrant returns (uint256 amount) {
        LockedPosition storage pos = _positionOf[token];
        if (!pos.curveOpened || (asset != pos.token0 && asset != pos.token1)) revert UnknownPosition();
        amount = hydeClaimable[token][asset];
        if (amount == 0) return 0;
        hydeClaimable[token][asset] = 0;
        accountedBalance[asset] -= amount;
        IERC20(asset).safeTransfer(HYDE_TREASURY, amount);
        emit HydeClaimed(token, asset, HYDE_TREASURY, amount);
    }

    function positionInfo(address token)
        external
        view
        returns (
            address creator,
            address token0,
            address token1,
            address numeraire,
            uint24 feeTier,
            bool curveOpened,
            bool positionsRegistered,
            uint256 positionCount_
        )
    {
        LockedPosition storage pos = _positionOf[token];
        return (
            pos.creator,
            pos.token0,
            pos.token1,
            pos.numeraire,
            pos.feeTier,
            pos.curveOpened,
            pos.positionsRegistered,
            pos.tokenIds.length
        );
    }

    function positionCount(address token) external view returns (uint256) {
        return _positionOf[token].tokenIds.length;
    }

    function positionIdAt(address token, uint256 index) external view returns (uint256) {
        return _positionOf[token].tokenIds[index];
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
