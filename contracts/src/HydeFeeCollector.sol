// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IHydeVault} from "./interfaces/IHydeVault.sol";

/// @title HydeFeeCollector — permanent V4 LP custodian + swap-free / split-free fee harvest
/// @notice CONTRACT_SPEC_L3.md §4 (rev7 · V4). Custodies each launch's v4 position ERC-721 FOREVER
///         (custody-lock: no transfer/approve/setApprovalForAll/decreaseLiquidity/burn/generic-call/
///         onERC721Received-forward path exists here — locked-by-absence on OUR NFT only; external LPs
///         on the same pool stay freely removable). `collect` is permissionless, swap-free and
///         split-free: a zero-liquidity `INCREASE_LIQUIDITY` credits the position's owed fees,
///         `TAKE_PAIR` sweeps both currencies here, and the measured deltas are `noteRaw`'d into the
///         vault (which settles + splits 90/5/5). No router, no split, no creator payout (INV-14/EXT/41).
///         The graduation metric lives in the hook (`swapVolume`), NOT here.
contract HydeFeeCollector {
    using SafeERC20 for IERC20;

    /* ─────────────────────────── immutables ────────────────────────────────── */
    IPositionManager public immutable POSITION_MANAGER;
    IPoolManager public immutable POOL_MANAGER;
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
        uint256 tokenId; // the v4 position held here forever
        address numeraire; // == WETH (asserted at register; INV-31/34)
        uint256 graduationThreshold; // milestone target (label only)
    }

    mapping(address => Position) public positionOf;

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

    constructor(IPositionManager positionManager, IPoolManager poolManager, IHydeVault vault, address weth) {
        require(address(positionManager) != address(0), "ZERO_PM");
        require(address(poolManager) != address(0), "ZERO_POOL_MANAGER");
        require(address(vault) != address(0), "ZERO_VAULT");
        require(weth != address(0), "ZERO_WETH");
        POSITION_MANAGER = positionManager;
        POOL_MANAGER = poolManager;
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

    /* ─────────────────────────── collect (swap-free, V4) ───────────────────── */
    /// @notice Permissionless, SWAP-FREE, SPLIT-FREE. Harvests accrued v4 fees ({LT, WETH}) into the
    ///         vault. A zero-liquidity `INCREASE_LIQUIDITY` credits the position's owed fees;
    ///         `TAKE_PAIR` sweeps both currencies here (PositionManager owns the unlock); the measured
    ///         deltas are `noteRaw`'d (vault pulls + measures — donation-proof). No router/split/payout.
    function collect(address token) external nonReentrant {
        Position memory pos = positionOf[token];
        require(pos.registered, "UNKNOWN");

        (Currency c0, Currency c1) = _currencies(token);
        uint256 ltBefore = IERC20(token).balanceOf(address(this));
        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));

        bytes memory actions = abi.encodePacked(uint8(Actions.INCREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        // INCREASE_LIQUIDITY(tokenId, liquidity=0, amount0Max, amount1Max, hookData) — zero-liq fee credit.
        params[0] = abi.encode(pos.tokenId, uint256(0), type(uint128).max, type(uint128).max, bytes(""));
        // TAKE_PAIR(currency0, currency1, recipient) — sweep both currencies here.
        params[1] = abi.encode(c0, c1, address(this));
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        uint256 ltIn = IERC20(token).balanceOf(address(this)) - ltBefore;
        uint256 wethIn = IERC20(WETH).balanceOf(address(this)) - wethBefore;
        if (ltIn > 0) _note(token, token, ltIn);
        if (wethIn > 0) _note(token, WETH, wethIn);
        emit FeesCollected(token, ltIn, wethIn);
    }

    /// @dev Hand one harvested asset to the vault: approve exact → vault pulls+measures → reset to 0.
    function _note(address token, address asset, uint256 amount) private {
        IERC20(asset).forceApprove(address(VAULT), amount);
        VAULT.noteRaw(token, asset, amount);
        IERC20(asset).forceApprove(address(VAULT), 0);
    }

    function _currencies(address token) internal view returns (Currency c0, Currency c1) {
        (c0, c1) =
            token < WETH ? (Currency.wrap(token), Currency.wrap(WETH)) : (Currency.wrap(WETH), Currency.wrap(token));
    }

    /* ─────────────────────────── graduate (STUBBED) ────────────────────────── */
    /// @notice DISABLED pending the clint-pinned threshold + policy on the (self-fundable, label-only)
    ///         hook `swapVolume` milestone. Un-stubbing is later a set-threshold + swapVolume-check +
    ///         delete-revert change; no liquidity ever moves.
    function graduate(address /*token*/ ) external pure {
        revert("GRADUATION_PENDING");
    }

    /* ─────────────────────────── NFT custody ───────────────────────────────── */
    /// @notice Accept the position NFT. Returns the selector but NEVER forwards or acts — the NFT has
    ///         no way out of this contract (no transfer/approve/withdraw selector exists here).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
