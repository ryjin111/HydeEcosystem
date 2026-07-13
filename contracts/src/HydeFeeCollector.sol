// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPositionManager} from "./interfaces/IPositionManager.sol";

/// @notice Burnable interface for the launch token's buyback leg (§4). `burn` is onlyCollector.
interface IHydeBurnable {
    function burn(uint256 amount) external;
}

/// @title HydeFeeCollector — permanent LP custodian + permissionless 90/5/5 fee split
/// @notice CONTRACT_SPEC_L3.md §4 (rev dcbb5cf). Holds every launch's Uniswap V3 position NFT
///         forever. LP is locked by the ABSENCE of any withdraw/decreaseLiquidity/transfer/approve
///         path — no owner, no admin, no generic call/delegatecall/multicall (INV-4, INV-14).
///         `collect` splits each accrued fee asset 90% creator / 5% Hydeout / 5% buyback&burn:
///         the launch-token buyback leg is BURNED directly (swap-free, MEV-free — INV-18);
///         a numéraire buyback leg only accrues to `buybackSink` (a separate guarded buyback acts later).
contract HydeFeeCollector {
    /* ─────────────────────────── immutables ────────────────────────────────── */
    IPositionManager public immutable POSITION_MANAGER;
    /// @notice Split legs — the AUTHORITATIVE source for `collect` (runs here; no cross-contract read).
    address public immutable hydeoutTreasury;
    address public immutable buybackSink;
    uint16 public immutable hydeoutBps; // == 500 (5%)
    uint16 public immutable buybackBps; // == 500 (5%)
    // creatorBps is the enforced remainder (1e4 - hydeoutBps - buybackBps == 9000) — never stored,
    // so the creator can't be short-changed by config drift.
    uint16 private constant BPS_DENOM = 10_000;

    /// @notice the one factory allowed to `register`. Fixed once, then locked (kami audit pt.3).
    address public factory;
    address private immutable _deployer;

    /* ─────────────────────────── registry ──────────────────────────────────── */
    struct Position {
        bool registered;
        bool graduated;
        address creator; // immutable recipient of the 90% (INV-3)
        uint256 tokenId; // the V3 position held here forever
        address numeraire; // token the (future) graduation metric is denominated in
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
    event FeesCollected(
        address indexed token,
        address indexed creator,
        uint256 creatorAmt0,
        uint256 hydeoutAmt0,
        uint256 buybackAmt0,
        uint256 creatorAmt1,
        uint256 hydeoutAmt1,
        uint256 buybackAmt1
    );
    event BuybackBurned(address indexed token, uint256 amountBurned);
    event Graduated(address indexed token, uint256 atMetric);

    /// @param positionManager the Uniswap V3 NonfungiblePositionManager holding launch positions.
    /// @param _hydeoutTreasury 5% platform recipient (from the reviewed per-chain manifest).
    /// @param _buybackSink recipient of the numéraire buyback leg (guarded buyback acts separately).
    /// @param _hydeoutBps must equal 500. @param _buybackBps must equal 500.
    constructor(
        IPositionManager positionManager,
        address _hydeoutTreasury,
        address _buybackSink,
        uint16 _hydeoutBps,
        uint16 _buybackBps
    ) {
        require(address(positionManager) != address(0), "ZERO_PM"); // no launch could ever collect
        require(_hydeoutBps == 500 && _buybackBps == 500, "BPS"); // hard-capped, immutable (INV-2)
        require(_hydeoutBps + _buybackBps < BPS_DENOM, "BPS_SUM"); // creator remainder stays majority
        require(_hydeoutTreasury != address(0) && _buybackSink != address(0), "ZERO_RECIPIENT");
        POSITION_MANAGER = positionManager;
        hydeoutTreasury = _hydeoutTreasury;
        buybackSink = _buybackSink;
        hydeoutBps = _hydeoutBps;
        buybackBps = _buybackBps;
        _deployer = msg.sender;
    }

    /// @notice One-shot factory binding. Callable exactly once, only by the deployer (kami audit pt.3
    ///         fallback; no init-seizure — a 2nd call / non-deployer reverts).
    function initFactory(address factory_) external {
        require(msg.sender == _deployer, "ONLY_DEPLOYER");
        require(factory == address(0), "FACTORY_SET");
        require(factory_ != address(0), "ZERO_FACTORY");
        factory = factory_;
    }

    /* ─────────────────────────── registration ──────────────────────────────── */
    /// @notice Records a launch's immutable custody facts. Written ONCE by the factory, never mutated.
    ///         Fee recipients are collector-level immutables, so they are NOT stored per token.
    function register(address token, address creator, uint256 tokenId, address numeraire, uint256 graduationThreshold)
        external
        onlyFactory
    {
        require(!positionOf[token].registered, "REGISTERED");
        require(token != address(0) && creator != address(0), "ZERO");
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

    /* ─────────────────────────── collect (90/5/5) ──────────────────────────── */
    /// @notice Permissionless. Pulls accrued V3 fees into this contract, then splits each token
    ///         90% creator / 5% Hydeout / 5% buyback. The launch-token buyback leg is burned
    ///         directly (swap-free); a numéraire buyback leg goes to `buybackSink`. Atomic — reverts
    ///         on any transfer/burn failure (no partial split).
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

        (uint256 c0, uint256 h0, uint256 b0) = _splitAsset(token, token0, pos.creator, amt0);
        (uint256 c1, uint256 h1, uint256 b1) = _splitAsset(token, token1, pos.creator, amt1);

        emit FeesCollected(token, pos.creator, c0, h0, b0, c1, h1, b1);
    }

    /// @dev Splits one collected asset. Creator receives the remainder (`amt - hydeout - buyback`) so
    ///      the two 5% legs are exact and all rounding lands on the creator (creator ≥ 90%, INV-1).
    ///      Buyback leg: burn if the asset IS the launch token (supply↓, swap-free); else send to sink.
    function _splitAsset(address launchToken, address asset, address creator, uint256 amt)
        private
        returns (uint256 creatorCut, uint256 hydeoutCut, uint256 buybackCut)
    {
        if (amt == 0) return (0, 0, 0);
        hydeoutCut = (amt * hydeoutBps) / BPS_DENOM;
        buybackCut = (amt * buybackBps) / BPS_DENOM;
        creatorCut = amt - hydeoutCut - buybackCut;

        if (hydeoutCut > 0) _safeTransfer(asset, hydeoutTreasury, hydeoutCut);
        if (buybackCut > 0) {
            if (asset == launchToken) {
                IHydeBurnable(asset).burn(buybackCut); // LT leg: real burn — supply↓, no swap, no MEV
                emit BuybackBurned(launchToken, buybackCut);
            } else {
                _safeTransfer(asset, buybackSink, buybackCut); // N leg: accrue for a separate guarded buyback
            }
        }
        _safeTransfer(asset, creator, creatorCut);
    }

    /* ─────────────────────────── graduate (STUBBED) ────────────────────────── */
    /// @notice DISABLED pending a griefable-proof monotonic metric (kami audit 21162.4). The previous
    ///         `tokensOwed`-based read was resettable by anyone front-running `collect`, which could
    ///         indefinitely block graduation. Re-enable only once gojo + kuro pin a monotonic source
    ///         (accumulated numéraire counter, not instantaneous owed). No liquidity ever moves (Option A).
    function graduate(
        address /*token*/
    )
        external
        pure
    {
        revert("GRADUATION_PENDING");
    }

    /* ─────────────────────────── NFT custody ───────────────────────────────── */
    /// @notice Accept the position NFT. Returns the selector but NEVER forwards or acts — the NFT
    ///         has no way out of this contract (no transfer/approve/withdraw selector exists anywhere).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /* ─────────────────────────── minimal SafeERC20 ─────────────────────────── */
    function _safeTransfer(address asset, address to, uint256 amount) private {
        (bool ok, bytes memory data) = asset.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FAILED");
    }
}
