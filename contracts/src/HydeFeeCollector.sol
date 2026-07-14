// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPositionManager} from "./interfaces/IPositionManager.sol";
import {IHydeVault} from "./interfaces/IHydeVault.sol";

/// @title HydeFeeCollector — permanent LP custodian + SWAP-FREE / SPLIT-FREE fee harvest
/// @notice CONTRACT_SPEC_L3.md §4 (rev6). Holds every launch's Uniswap V3 position NFT FOREVER
///         (LP locked by the ABSENCE of any withdraw/decreaseLiquidity/transfer/approve/generic-call
///         path — no owner, no admin, INV-4/14). `collect` is **swap-free and split-free**: it only
///         harvests the raw V3 fee assets ({LT, WETH}) and `noteRaw`s them into the vault (which does
///         the WETH settlement + 90/5/5 split). No router, no split, no creator payout here (INV-18).
///         `graduationProgress` (WETH) is monotonic (INV-20); `graduate` is stubbed.
contract HydeFeeCollector {
    using SafeERC20 for IERC20;

    /* ─────────────────────────── immutables ────────────────────────────────── */
    IPositionManager public immutable POSITION_MANAGER;
    IHydeVault public immutable VAULT;
    /// @notice WETH (= the vault's SETTLEMENT_TOKEN); the sole permitted pool numéraire (INV-34).
    address public immutable WETH;

    /// @notice the one factory allowed to `register`. Set once via `initFactory`, then locked.
    address public factory;
    address private immutable _deployer;

    /* ─────────────────────────── registry ──────────────────────────────────── */
    struct Position {
        bool registered;
        bool graduated; // one-way (set only by a future un-stubbed `graduate`)
        address creator; // immutable custody fact (the vault holds the real recipient)
        uint256 tokenId; // the V3 position held here forever
        address numeraire; // == WETH (asserted at register; INV-31/34)
        uint256 graduationThreshold; // milestone target (label only)
    }

    mapping(address => Position) public positionOf;
    /// @notice monotonic cumulative WETH fees harvested for a token — the graduation metric (INV-20).
    mapping(address => uint256) public graduationProgress;

    /* ─────────────────────────── reentrancy ────────────────────────────────── */
    uint256 private _lock = 1;

    modifier nonReentrant() {
        require(_lock == 1, "REENTRANCY");
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyFactory() {
        require(msg.sender == factory, "ONLY_FACTORY");
        _;
    }

    /* ─────────────────────────── events ────────────────────────────────────── */
    event PositionRegistered(address indexed token, address indexed creator, uint256 tokenId);
    event FeesCollected(address indexed token, uint256 amtLT, uint256 amtWETH);
    event Graduated(address indexed token, uint256 atProgress);

    /// @param positionManager the Uniswap V3 NonfungiblePositionManager holding launch positions.
    /// @param vault           the shared HydeFeeVault that settles + splits harvested fees.
    constructor(IPositionManager positionManager, IHydeVault vault, address weth) {
        require(address(positionManager) != address(0), "ZERO_PM");
        require(address(vault) != address(0), "ZERO_VAULT");
        require(weth != address(0), "ZERO_WETH");
        POSITION_MANAGER = positionManager;
        VAULT = vault;
        WETH = weth;
        _deployer = msg.sender;
    }

    /// @notice One-shot factory binding (deployer-only, once). A 2nd call / non-deployer reverts.
    function initFactory(address factory_) external {
        require(msg.sender == _deployer, "ONLY_DEPLOYER");
        require(factory == address(0), "FACTORY_SET");
        require(factory_ != address(0), "ZERO_FACTORY");
        factory = factory_;
    }

    /* ─────────────────────────── registration ──────────────────────────────── */
    /// @notice Records a launch's immutable custody facts. Written ONCE by the factory. Asserts the
    ///         pool numéraire is WETH — the own-stack LT/WETH lock (INV-31/34).
    function register(address token, address creator, uint256 tokenId, address numeraire, uint256 graduationThreshold)
        external
        onlyFactory
    {
        require(!positionOf[token].registered, "REGISTERED");
        require(token != address(0) && creator != address(0), "ZERO");
        require(numeraire == WETH, "NUMERAIRE"); // LT/WETH lock (INV-34)
        positionOf[token] = Position({
            registered: true,
            graduated: false,
            creator: creator,
            tokenId: tokenId,
            numeraire: numeraire,
            graduationThreshold: graduationThreshold
        });
        emit PositionRegistered(token, creator, tokenId);
    }

    /* ─────────────────────────── collect (swap-free) ───────────────────────── */
    /// @notice Permissionless, SWAP-FREE, SPLIT-FREE. Harvests accrued V3 fees ({LT, WETH}) into the
    ///         vault via `noteRaw` (vault pulls + measures). Advances the WETH `graduationProgress`
    ///         (monotonic). No router, no split, no creator payout. Atomic — reverts on any failure.
    function collect(address token) external nonReentrant {
        Position memory pos = positionOf[token];
        require(pos.registered, "UNKNOWN");

        (,, address token0, address token1,,,,,,,,) = POSITION_MANAGER.positions(pos.tokenId);

        (uint256 amt0, uint256 amt1) = POSITION_MANAGER.collect(
            IPositionManager.CollectParams({
                tokenId: pos.tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        if (amt0 > 0) _note(token, token0, amt0);
        if (amt1 > 0) _note(token, token1, amt1);

        // WETH leg feeds the graduation metric (monotonic; INV-20). numeraire == WETH (asserted).
        uint256 amtWETH = token0 == pos.numeraire ? amt0 : amt1;
        uint256 amtLT = token0 == pos.numeraire ? amt1 : amt0;
        if (amtWETH > 0) graduationProgress[token] += amtWETH;

        emit FeesCollected(token, amtLT, amtWETH);
    }

    /// @dev Hand one harvested asset to the vault: approve exact → vault pulls+measures → reset to 0.
    function _note(address token, address asset, uint256 amount) private {
        IERC20(asset).forceApprove(address(VAULT), amount);
        VAULT.noteRaw(token, asset, amount);
        IERC20(asset).forceApprove(address(VAULT), 0);
    }

    /* ─────────────────────────── graduate (STUBBED) ────────────────────────── */
    /// @notice DISABLED pending the pinned threshold + the clint/Reviewer policy decision on the
    ///         (self-fundable, label-only) LP-fee milestone (kami 21280 / gojo 21281). Un-stubbing is
    ///         later a set-immutable-threshold + delete-this-revert change; no liquidity ever moves.
    function graduate(address /*token*/ ) external pure {
        revert("GRADUATION_PENDING");
    }

    /* ─────────────────────────── NFT custody ───────────────────────────────── */
    /// @notice Accept the position NFT. Returns the selector but NEVER forwards or acts — the NFT
    ///         has no way out of this contract (no transfer/approve/withdraw selector exists here).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
